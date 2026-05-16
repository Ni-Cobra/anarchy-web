/**
 * What happens each frame. The `Renderer` orchestrates the per-frame
 * update pipeline: it reads from the snapshot buffer, composes player
 * entities, syncs meshes, advances effects, samples daylight, updates
 * light pools, and finally renders. The persistent scene graph it paints
 * into lives in `SceneGraph` — this class never creates GPU resources
 * itself, only drives the ones the graph owns.
 *
 * The renderer is networking- and DOM-agnostic: the caller supplies a
 * container element, an initial `Viewport`, and is responsible for
 * forwarding window resizes via `resize()`. The wire layer feeds `World`
 * / `SnapshotBuffer` / `Terrain` and tells us who we are with
 * `setLocalPlayerId`.
 */

import * as THREE from "three";

import {
  CAMERA_HEIGHT,
  ZOOM_OUT_CAMERA_HEIGHT,
  ZOOM_STEP_FACTOR,
  ZOOM_TWEEN_MS,
} from "../config.js";
import {
  type Inventory,
  type ItemId,
  type PlayerId,
  type SnapshotBuffer,
  type Terrain,
  type World,
} from "../game/index.js";
import { composePlayerEntities } from "./compose.js";
import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
} from "./sync.js";
import {
  pickBlockUnderCursor,
  pickEntityUnderCursor,
  pickPlayerUnderCursor,
  type PickResult,
} from "./picker.js";
import { tileCenterToScene } from "./terrain.js";
import { sampleDaylight } from "./daylight.js";
import {
  type BlockEditEvent,
  type ChestBeamTarget,
  type TargetingStateEvent,
} from "./effects/index.js";
import { MS_PER_TICK, reconstructChargeStartMs } from "./attack_beam_layer.js";
import { computeGhostState, type GhostState } from "./ghost.js";
import {
  applyHoverBillboards,
  applyLanternBodyUnlit,
  defaultPlayerMeshFactory,
} from "./player_mesh.js";
import { SceneGraph, type Viewport } from "./scene_graph.js";
import { ScreenShake, type ScreenShakeOffset } from "./screen_shake.js";
import { ZoomController, clampZoomHeight } from "./zoom.js";

export type { Viewport } from "./scene_graph.js";

// Day-cycle sun-position radius (mirrors `scene_graph.ts`). The per-frame
// daylight sample places the directional sun at this offset from the
// local-player focus so its world-space angle reads correctly from any
// viewpoint while keeping the shadow camera frustum bounded.
const SUN_DISTANCE = 60;

/**
 * Duration of the strike-dash render-side animation (task 070b). The
 * server teleports the attacker instantaneously when the charge
 * resolves; the renderer lerps the visible position over this window
 * so the dash reads as a deliberate motion instead of a snap. Pinned
 * shorter than `REMOTE_RENDER_DELAY_MS` so the lerp finishes before the
 * standard interpolation lag would deliver the new pos through compose.
 */
export const DASH_DURATION_MS = 150;

/**
 * Cooldown affordance window (task 070b). Mirrors the server's
 * `COOLDOWN_DURATION_SECS = 5.0`. The local player's HUD reads the
 * latest strike-time and renders a depleting badge for this long.
 */
export const COOLDOWN_DURATION_MS = 5000;

/**
 * Owns the Three.js render loop. Per ADR 0003 every player — local and
 * remote — renders from `SnapshotBuffer` with the same
 * `REMOTE_RENDER_DELAY_MS` interpolation delay; `LocalPredictor` was
 * retired with the chunk-centric refactor. Local input now feels the
 * server tick, which is the known regression until a future task
 * reintroduces prediction.
 */
export class Renderer {
  private readonly graph: SceneGraph;
  private readonly meshes = new Map<PlayerId, THREE.Mesh>();
  private readonly factory: PlayerMeshFactory;
  private readonly now: () => number;
  private localPlayerId: PlayerId | null = null;
  private terrain: Terrain | null;
  private readonly inventory: Inventory | null;
  private readonly getSelectedHotbarSlot: () => number;
  // Latest synced `time_of_day_seconds` from the wire layer. The renderer
  // reads this every frame to compute the current sample. Initialised to
  // `0` (sunrise) so the very first frame, before any TickUpdate has
  // landed, has a sane envelope rather than a random uninitialized number.
  private timeOfDaySeconds = 0;
  // Camera-height tween (see `render/zoom.ts`). Holds the source-of-truth
  // for both the M preset toggle and the continuous +/- / Ctrl+Wheel
  // bindings. Sampled once per frame in `updateCamera`. `zoomedOut` is
  // kept around as a separate flag because it also gates the chunk-border
  // grid (debug-only overlay), which is independent of the camera height.
  private readonly zoom: ZoomController;
  private zoomedOut = false;
  // Wall-clock timestamp of the last `frame()` call. `null` until the first
  // frame so we can flag the initial sync as "no smoothing" (an unknown
  // previous yaw makes the lerp meaningless until we have a real delta).
  private lastFrameMs: number | null = null;
  // Last NDC the input layer reported. `null` means the cursor is not over
  // the canvas (or hasn't moved yet) — no player is considered hovered.
  // Re-evaluated every frame against current mesh positions so a player
  // walking under a stationary cursor still triggers the hover-billboard.
  private cursorNdc: { x: number; y: number } | null = null;
  // Last rendered position per player (task 070b). Captured at the end
  // of each frame so the dash-on-strike animation can lerp from
  // wherever the attacker was actually drawn, not wherever the snapshot
  // buffer happened to be looking. Cleared on local-player reassign.
  private readonly lastRenderedPos = new Map<PlayerId, { x: number; y: number }>();
  // Per-attacker dash override (task 070b). On a strike resolution we
  // capture the attacker's last rendered position, the wall-clock at
  // which the strike landed, and lerp the rendered position toward the
  // authoritative world position over `DASH_DURATION_MS`. Overrides the
  // standard compose path for the attacker's frame only — every other
  // player continues to read from `SnapshotBuffer` as usual.
  private readonly activeDashes = new Map<PlayerId, {
    fromX: number;
    fromY: number;
    startMs: number;
  }>();
  // Reconstruction anchor for the server tick clock (task 070b). The
  // first `charge-started` of an attack carries a `started_at_tick`
  // equal to the server's current tick, so the moment the event
  // arrives locally we can pin `(tick → wall-clock ms)` for the whole
  // attack. Every subsequent strike event for the same attack uses the
  // same anchor so the shrinking-beam phase stays sync'd across
  // observers regardless of network latency.
  private readonly tickAnchorByAttacker = new Map<PlayerId, {
    anchorTick: number;
    anchorMs: number;
  }>();
  /**
   * Latest `strike-*` time per attacker (wall-clock ms). Drives the
   * cooldown affordance for the local player; remote attackers' values
   * exist for symmetry but the UI only reads the local entry.
   */
  private readonly cooldownStartMsByAttacker = new Map<PlayerId, number>();
  /**
   * Damage-feedback shake (task 120). Source-agnostic — the session calls
   * `triggerScreenShake(...)` on a local-HP drop; task 130 wires the
   * attacker's own strike-shake through the same surface. Sampled in
   * `updateCamera` so the offset perturbs both `camera.position` and the
   * look-at target by the same vector, producing a pure visual translation
   * without rotating the view.
   */
  private readonly screenShake = new ScreenShake();

  constructor(
    private readonly world: World,
    private readonly buffer: SnapshotBuffer,
    container: HTMLElement,
    viewport: Viewport,
    terrain: Terrain | null = null,
    factory: PlayerMeshFactory = defaultPlayerMeshFactory,
    now: () => number = () => Date.now(),
    inventory: Inventory | null = null,
    getSelectedHotbarSlot: () => number = () => 0,
  ) {
    this.terrain = terrain;
    this.factory = factory;
    this.now = now;
    this.inventory = inventory;
    this.getSelectedHotbarSlot = getSelectedHotbarSlot;

    this.graph = new SceneGraph(container, viewport, terrain, (id) => {
      const player = this.world.getPlayer(id);
      return player ? player.colorIndex : null;
    });

    this.zoom = new ZoomController(CAMERA_HEIGHT, ZOOM_TWEEN_MS, this.now());

    this.graph.webgl.setAnimationLoop(this.frame);
  }

  /**
   * Wire-layer hook (task 310). The latest `time_of_day_seconds` scalar
   * shipped on the most recent `TickUpdate`. Each frame `updateDaylight`
   * reads this and resamples sun direction / colour / ambient tint. The
   * scalar is monotonic per server (advances with each tick), so the
   * client just stores it verbatim — no easing or smoothing here; the
   * server-side advance is already a tick-rate-derivative scalar.
   */
  setTimeOfDaySeconds(seconds: number): void {
    this.timeOfDaySeconds = seconds;
  }

  setLocalPlayerId(id: PlayerId | null): void {
    if (this.localPlayerId === id) return;
    const affected = [this.localPlayerId, id].filter(
      (x): x is PlayerId => x !== null,
    );
    for (const pid of affected) {
      const mesh = this.meshes.get(pid);
      if (!mesh) continue;
      disposePlayerMesh(mesh, this.graph.playerGroup);
      this.meshes.delete(pid);
    }
    this.localPlayerId = id;
    // A local-player reassign means we just reconnected or the lobby
    // identity changed — drop every per-player carry-over so a fresh
    // session never inherits a dash, cooldown badge, or attack beam
    // from the previous one.
    this.lastRenderedPos.clear();
    this.activeDashes.clear();
    this.tickAnchorByAttacker.clear();
    this.cooldownStartMsByAttacker.clear();
    this.screenShake.reset();
    this.graph.attackBeams.clearAll();
  }

  setTerrain(terrain: Terrain): void {
    this.terrain = terrain;
  }

  /**
   * Debug zoom-out toggle (bound to `M` in `bootstrap.ts`). When on, the
   * top-down camera retargets to `ZOOM_OUT_CAMERA_HEIGHT` and the chunk-
   * border grid is shown; off retargets back to `CAMERA_HEIGHT` and hides
   * the grid. The retarget eases via `ZoomController` so the camera
   * doesn't snap; the grid still toggles instantly because it's a debug
   * overlay where fade-ins would just look fussy.
   */
  setZoomedOut(on: boolean): void {
    if (this.zoomedOut === on) return;
    this.zoomedOut = on;
    this.graph.setChunkBorderVisible(on);
    this.zoom.setTarget(
      on ? ZOOM_OUT_CAMERA_HEIGHT : CAMERA_HEIGHT,
      this.now(),
    );
  }

  /**
   * Continuous zoom step (`+` / `-` / `Ctrl+Wheel`). `direction` is +1 to
   * zoom in (camera lower) or -1 to zoom out (camera higher). The new
   * target is `current_target * ZOOM_STEP_FACTOR^(-direction)`, clamped
   * to `[ZOOM_HEIGHT_MIN, ZOOM_HEIGHT_MAX]`. Mid-tween retargets stay
   * continuous — see `ZoomController.setTarget`.
   */
  nudgeZoom(direction: 1 | -1): void {
    const factor = direction > 0 ? 1 / ZOOM_STEP_FACTOR : ZOOM_STEP_FACTOR;
    const next = clampZoomHeight(this.zoom.target() * factor);
    this.zoom.setTarget(next, this.now());
  }

  /**
   * Cursor-driven world pick. `cursorNdc` is normalized device coords
   * (`x`, `y` ∈ [-1, 1]); the renderer owns the camera, so this method
   * keeps callers out of `three`. Returns `null` if no terrain is loaded
   * or the cursor falls outside any loaded chunk — see `picker.ts`.
   */
  pickAtCursor(
    cursorNdc: { readonly x: number; readonly y: number },
  ): PickResult | null {
    if (!this.terrain) return null;
    return pickBlockUnderCursor(cursorNdc, this.graph.camera, this.terrain);
  }

  /**
   * Cursor-driven attack-target pick (task 070b). Returns the first
   * player-or-entity whose render hit the cursor, or `null` when no
   * target is under the cursor. Players take precedence over entities
   * sharing the same tile so a body-occluded spider doesn't steal the
   * click. The local player is filtered out — a click that hits the
   * caller's own body cannot be an attack.
   */
  pickAttackTargetAtCursor(
    cursorNdc: { readonly x: number; readonly y: number },
  ): { kind: "player"; id: PlayerId } | { kind: "entity"; id: number } | null {
    const playerHit = pickPlayerUnderCursor(cursorNdc, this.graph.camera, this.meshes);
    if (playerHit !== null && playerHit !== this.localPlayerId) {
      return { kind: "player", id: playerHit };
    }
    if (this.terrain === null) return null;
    const entityHit = pickEntityUnderCursor(
      cursorNdc,
      this.graph.camera,
      this.terrain,
    );
    if (entityHit !== null) return { kind: "entity", id: entityHit };
    return null;
  }

  /**
   * Tell the renderer where the cursor currently is in NDC, or `null` to
   * clear (cursor left the canvas). Drives hover-only username billboards:
   * the per-frame loop re-runs `pickPlayerUnderCursor` against this NDC and
   * toggles each player's billboard sprite.
   */
  setCursorNdc(
    cursorNdc: { readonly x: number; readonly y: number } | null,
  ): void {
    this.cursorNdc = cursorNdc === null ? null : { x: cursorNdc.x, y: cursorNdc.y };
  }

  /**
   * Latest ghost-preview state computed by the per-frame driver, or `null`
   * when nothing is being previewed (no held block, no valid target). Read
   * by Playwright via `__anarchy.getGhostState()` to assert visibility
   * end-to-end without inspecting Three.js internals.
   */
  getGhostState(): GhostState | null {
    return this.graph.ghost.getState();
  }

  /**
   * Test handle (task 370): number of player-attached lantern lights
   * currently visible in the scene. Visible means `nightFactor > 0` AND
   * the player is wearing a lantern; a daylight scene with lantern-
   * wearers reports `0`. Lets a Playwright spec assert "the lantern
   * light is in the scene at night" without poking at Three.js
   * internals.
   */
  getLanternLightCount(): number {
    return this.graph.lanternLights.visibleCount();
  }

  /**
   * The wire layer just observed a per-tick block-edit (place / break)
   * attributed to a player. Spawns a one-shot effect at the cell tinted
   * by the actor's color. See `EffectsLayer.onBlockEdit`.
   */
  onBlockEdit(event: BlockEditEvent): void {
    const nowMs = this.now();
    this.graph.effects.onBlockEdit(event, nowMs);
    if (event.kind === "placed") {
      this.graph.beams.onPlace(event, nowMs);
    } else {
      const center = tileCenterToScene(event.cx, event.cy, event.lx, event.ly);
      this.graph.breakParticles.spawn(center.x, center.z, event.blockType, nowMs);
    }
  }

  /**
   * The wire layer just observed this tick's full set of held-break
   * targeting states. Replaces the live targeting overlays wholesale.
   */
  applyTargetingStates(targets: readonly TargetingStateEvent[]): void {
    this.graph.effects.applyTargets(targets);
    this.graph.beams.applyBreakTargets(targets);
  }

  /**
   * The wire layer observed `TickUpdate.attack_events` (task 070b).
   * Routes each event into the beam layer, captures dash anchors for
   * the dash render-side animation, and pins the cooldown timestamp
   * for the local player's HUD affordance.
   *
   * `tickReceivedMs` is the wall-clock at which the tick frame landed
   * locally — used as the anchor for converting the server's
   * `started_at_tick` into a charge-start wall-clock that all observers
   * agree on (modulo their own clock skew on the inbound frame).
   */
  onAttackEvents(
    events: ReadonlyArray<{
      readonly attackerPlayerId: number;
      readonly targetKind: "player" | "entity";
      readonly targetId: number;
      readonly outcome: "charge-started" | "strike-hit" | "strike-missed";
      readonly startedAtTick: number;
    }>,
    tickReceivedMs: number,
  ): void {
    for (const ev of events) {
      if (ev.outcome === "charge-started") {
        // Pin a fresh `(tick, wall-clock)` anchor for this attack so
        // the beam-shrink phase is reconstructed from server time.
        this.tickAnchorByAttacker.set(ev.attackerPlayerId, {
          anchorTick: ev.startedAtTick,
          anchorMs: tickReceivedMs,
        });
        const colorIndex =
          this.world.getPlayer(ev.attackerPlayerId)?.colorIndex ?? 0;
        const chargeStartMs = reconstructChargeStartMs(
          ev.startedAtTick,
          ev.startedAtTick,
          tickReceivedMs,
        );
        this.graph.attackBeams.onCharge(
          ev.attackerPlayerId,
          ev.targetKind,
          ev.targetId,
          colorIndex,
          chargeStartMs,
        );
      } else {
        // STRIKE_HIT or STRIKE_MISSED. Retire the beam, capture the
        // current rendered position as the dash "from", and pin the
        // cooldown start.
        this.graph.attackBeams.onResolve(ev.attackerPlayerId);
        const from = this.lastRenderedPos.get(ev.attackerPlayerId);
        if (from !== undefined) {
          this.activeDashes.set(ev.attackerPlayerId, {
            fromX: from.x,
            fromY: from.y,
            startMs: this.now(),
          });
        }
        // Server's resolution tick = startedAtTick + CHARGE_TICKS, but
        // we don't need to reconstruct it here — the dash just lerps
        // from "last rendered" to "current server pos" over a fixed
        // 150 ms window starting now.
        this.cooldownStartMsByAttacker.set(ev.attackerPlayerId, this.now());
        // The anchor is no longer needed once the strike has fired —
        // drop it so reconnect-style state never leaks.
        this.tickAnchorByAttacker.delete(ev.attackerPlayerId);
      }
    }
    // Mirror `tickReceivedMs` for the `MS_PER_TICK` debug aid the
    // unit tests reference — the variable is intentionally re-imported
    // even when unused at runtime so the constant stays explicit.
    void MS_PER_TICK;
  }

  /**
   * Test handle / cooldown read-out (task 070b). Returns the wall-clock
   * ms at which `playerId`'s most recent strike fired, or `null` if the
   * player has not struck this session. The HUD cooldown affordance
   * subscribes to this for the local player; e2e specs can poll it to
   * assert the strike landed without inspecting the renderer scene.
   */
  getStrikeStartedMs(playerId: PlayerId): number | null {
    return this.cooldownStartMsByAttacker.get(playerId) ?? null;
  }

  /**
   * Test handle (task 070b): scene-graph count of live attack beams.
   * Mirrors `EntityLayer.size()` shape.
   */
  getAttackBeamCount(): number {
    return this.graph.attackBeams.size();
  }

  /**
   * Damage-feedback hook (task 120). Caller (today: the bootstrap session
   * on a local-HP drop) supplies a peak magnitude (tiles) and a duration
   * (ms); the renderer applies the resulting offset to the camera each
   * frame. Magnitude is clamped inside `ScreenShake` so an absurd input
   * cannot eject the camera. The trigger surface is source-agnostic — task
   * 130 wires the attacker's own strike-shake here as well.
   */
  triggerScreenShake(magnitudeTiles: number, durationMs: number): void {
    this.screenShake.trigger(magnitudeTiles, durationMs, this.now());
  }

  /**
   * Test handle (task 120): current shake offset in tile units, or
   * `(0, 0)` when no shake is active. Lets e2e + bootstrap unit tests
   * pin the shake state end-to-end without inspecting the camera.
   */
  getScreenShakeOffset(): ScreenShakeOffset {
    return this.screenShake.offsetAt(this.now());
  }

  /**
   * The wire layer just inserted or replaced the chunk at `(cx, cy)`.
   * Replace just that chunk's sub-group inside the terrain mesh, leaving
   * neighbors untouched.
   */
  applyChunkLoaded(cx: number, cy: number): void {
    if (!this.terrain) return;
    this.graph.replaceChunk(cx, cy, this.terrain);
  }

  /**
   * The wire layer just removed the chunk at `(cx, cy)`. Drop its
   * sub-group from the terrain mesh.
   */
  applyChunkUnloaded(cx: number, cy: number): void {
    this.graph.removeChunk(cx, cy);
  }

  resize(width: number, height: number): void {
    this.graph.resize(width, height);
  }

  dispose(): void {
    this.graph.webgl.setAnimationLoop(null);
    for (const mesh of this.meshes.values()) {
      disposePlayerMesh(mesh, this.graph.playerGroup);
    }
    this.meshes.clear();
    this.graph.dispose();
  }

  private frame = () => {
    const nowMs = this.now();
    const dtMs = this.lastFrameMs === null ? Infinity : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    const composed = composePlayerEntities(this.world, this.buffer, nowMs);
    // Task 070b: any attacker mid-dash overrides the composed position
    // with a fast lerp from their pre-strike rendered position to the
    // authoritative world position. After `DASH_DURATION_MS` the
    // entry retires and the standard compose path resumes — by then
    // the snapshot-buffer interpolation has caught up.
    const entities = composed.map((e) => {
      const dash = this.activeDashes.get(e.id);
      if (dash === undefined) return e;
      const elapsed = nowMs - dash.startMs;
      if (elapsed >= DASH_DURATION_MS) {
        this.activeDashes.delete(e.id);
        return e;
      }
      const t = elapsed <= 0 ? 0 : elapsed / DASH_DURATION_MS;
      const authoritative = this.world.getPlayer(e.id);
      const targetX = authoritative ? authoritative.x : e.x;
      const targetY = authoritative ? authoritative.y : e.y;
      return {
        ...e,
        x: dash.fromX + (targetX - dash.fromX) * t,
        y: dash.fromY + (targetY - dash.fromY) * t,
      };
    });
    syncPlayerMeshes(
      entities,
      this.localPlayerId,
      this.meshes,
      this.graph.playerGroup,
      this.factory,
      dtMs,
    );
    this.updateCamera(entities);
    this.updateDaylight(entities);
    applyLanternBodyUnlit(this.meshes, entities);
    this.refreshHoverBillboards();
    this.refreshGhostPreview();
    this.graph.effects.update(nowMs);
    this.graph.breakParticles.update(nowMs);
    // Entities (task 010-entities, client half 020). Reads the
    // game-state entity mirror — populated by the wire bridge into
    // `Chunk.entities` — and smoothes mesh positions between tile
    // teleports.
    this.graph.entities.update(this.terrain, nowMs);
    // Chest beams (task 040) — refresh from the open-chest set carried
    // on every player snapshot so a beam exists for every (player,
    // chest) the server says is currently open. The world is rebuilt
    // each tick, so this re-pulls fresh.
    this.refreshChestBeams();
    // Beams aim at the same interpolated player positions that
    // `syncPlayerMeshes` just consumed so a beam stays glued to its
    // actor's body across remote-render delay.
    const positionByPlayer = new Map<PlayerId, { x: number; y: number }>();
    for (const e of entities) positionByPlayer.set(e.id, { x: e.x, y: e.y });
    this.graph.beams.update((id) => positionByPlayer.get(id) ?? null, nowMs);
    // Task 070b: the charge beam connects the attacker's body to the
    // target's body (player or entity), and aims at whichever position
    // is rendered this frame so a moving target keeps the beam glued
    // on. Entities are tile-bound; the entity-layer renders them at
    // the (interpolated) scene position derived from tile + stack
    // rank, but for the beam we want the *world* position — read the
    // tile centre out of the game-state mirror directly.
    this.graph.attackBeams.update((kind, id) => {
      if (kind === "player") {
        return positionByPlayer.get(id) ?? null;
      }
      // entity
      const terrain = this.terrain;
      if (terrain === null) return null;
      for (const [, chunk] of terrain.iter()) {
        const e = chunk.entities.get(id);
        if (e === undefined) continue;
        return { x: e.tileX + 0.5, y: e.tileY + 0.5 };
      }
      return null;
    }, nowMs);
    // Capture this frame's rendered player positions so a strike
    // resolution next frame can lerp from where the attacker is
    // actually drawn.
    this.lastRenderedPos.clear();
    for (const e of entities) {
      this.lastRenderedPos.set(e.id, { x: e.x, y: e.y });
    }
    this.graph.webgl.render(this.graph.scene, this.graph.camera);
  };

  private refreshGhostPreview(): void {
    if (this.inventory === null || this.terrain === null) {
      this.graph.ghost.apply(null);
      return;
    }
    const slot = this.inventory.slot(this.getSelectedHotbarSlot());
    const pick =
      this.cursorNdc === null
        ? null
        : pickBlockUnderCursor(this.cursorNdc, this.graph.camera, this.terrain);
    const state = computeGhostState({
      slot,
      pick,
      world: this.world,
      terrain: this.terrain,
      localPlayerId: this.localPlayerId,
    });
    this.graph.ghost.apply(state);
  }

  /**
   * Chest-beam refresh (task 040). Walks every player the world knows
   * about and collects one `ChestBeamTarget` per `(player, open chest)`
   * pair, then hands the union to the beam layer for a wholesale replace.
   * The set arrives via `PlayerSnapshot.open_chests` on every tick so
   * the renderer never has to track open/close transitions itself.
   */
  private refreshChestBeams(): void {
    const targets: ChestBeamTarget[] = [];
    for (const p of this.world.players()) {
      for (const c of p.openChests) {
        targets.push({
          playerId: p.id,
          cx: c.cx,
          cy: c.cy,
          lx: c.lx,
          ly: c.ly,
        });
      }
    }
    this.graph.beams.applyChestTargets(targets);
  }

  /**
   * Test handle (task 040): number of chest beams currently in the
   * scene. Lets a Playwright spec assert "one beam per open chest"
   * without poking at Three.js internals.
   */
  getChestBeamCount(): number {
    return this.graph.beams.chestBeamCount();
  }

  /**
   * Test handle (task 020-entities): scene-space `(x, z)` of every
   * entity mesh the renderer is currently showing, keyed by `EntityId`.
   * Lets an e2e spec pin "a spider appeared at the seeded tile" and "the
   * mesh has moved across the wait window" without inspecting Three.js
   * internals. The local `y` (height above ground) is omitted — it's
   * constant per kind and not load-bearing for the assertions.
   */
  getRenderedEntities(): Record<number, { x: number; z: number }> {
    const out: Record<number, { x: number; z: number }> = {};
    for (const r of this.graph.entities.iterRendered()) {
      out[r.id] = { x: r.x, z: r.z };
    }
    return out;
  }

  private refreshHoverBillboards(): void {
    // The picker uses `Raycaster.intersectObjects` which respects camera
    // matrices computed during the previous render — `updateCamera` has
    // already run this frame, so the picker sees the current view.
    const hoveredId =
      this.cursorNdc === null
        ? null
        : pickPlayerUnderCursor(this.cursorNdc, this.graph.camera, this.meshes);
    applyHoverBillboards(this.meshes, hoveredId);
  }

  /**
   * Sample the day cycle at the latest synced `time_of_day_seconds` and
   * push the result into the directional sun + ambient + sky background.
   * Anchors the sun and its shadow camera at the local player's focus
   * point so the shadow frustum stays glued to where the camera is
   * looking — chunks well outside the visible window aren't paying
   * shadow-render cost.
   */
  private updateDaylight(
    entities: readonly {
      id: PlayerId;
      x: number;
      y: number;
      equippedUtility: ItemId | null;
    }[],
  ): void {
    const sample = sampleDaylight(this.timeOfDaySeconds);
    this.graph.ambient.color.setHex(sample.ambientColor);
    this.graph.ambient.intensity = sample.ambientIntensity;
    this.graph.sun.color.setHex(sample.sunColor);
    this.graph.sun.intensity = sample.sunIntensity;
    (this.graph.scene.background as THREE.Color).setHex(sample.skyColor);

    const local =
      this.localPlayerId !== null
        ? entities.find((e) => e.id === this.localPlayerId)
        : undefined;
    const focus = local
      ? tileToScene(local.x, local.y)
      : new THREE.Vector3(0, 0, 0);
    this.graph.sun.target.position.copy(focus);
    this.graph.sun.target.updateMatrixWorld();
    this.graph.sun.position.set(
      focus.x + sample.sunDir.x * SUN_DISTANCE,
      focus.y + sample.sunDir.y * SUN_DISTANCE,
      focus.z + sample.sunDir.z * SUN_DISTANCE,
    );
    // The shadow map is computed in the sun's local frame, which derives
    // from `sun.position` + `sun.target.position`. Telling Three.js to
    // refresh the shadow camera matrix every frame is cheap (one matrix
    // multiply) and avoids ghost-shadows from a stale frustum.
    this.graph.sun.shadow.camera.updateProjectionMatrix();
    // Torches (task 350): light-pool driven by the same daylight sample
    // and the same focus point as the sun. Pinning the focus to the local
    // player keeps the "32 nearest torches" pick stable as the world
    // streams in around them.
    this.graph.torchLights.update({ x: focus.x, z: focus.z }, sample.nightFactor);
    // Mushrooms (task 140): cool-glow companion pool to the torch one,
    // same nearest-N pick around the focus, weaker radius/intensity so
    // they read as atmosphere rather than navigable light.
    this.graph.mushroomLights.update({ x: focus.x, z: focus.z }, sample.nightFactor);
    // Lanterns (task 370): one light per player wearing one. Driven by
    // the same `nightFactor` so the day cycle reads consistent across
    // every warm light source.
    this.graph.lanternLights.update(entities, sample.nightFactor);
  }

  private updateCamera(entities: readonly { id: PlayerId; x: number; y: number }[]) {
    // Follow the local player's interpolated position. With prediction
    // removed (ADR 0003 §7) this advances at the snapshot cadence — local
    // input feels the server tick.
    const local =
      this.localPlayerId !== null
        ? entities.find((e) => e.id === this.localPlayerId)
        : undefined;
    const focus = local
      ? tileToScene(local.x, local.y)
      : new THREE.Vector3(0, 0, 0);
    const height = this.zoom.sample(this.now());
    // Damage-feedback shake (task 120). Tile-space `(dx, dy)` from the
    // shake module maps to scene-space `(dx, 0, -dy)` (mirrors `tileToScene`),
    // then we perturb both the camera position and the look-at by the same
    // vector so the view translates without rotating. Applied as the very
    // last camera adjustment — the offset must not feed back into snapshot
    // reconciliation or the dash override.
    const shake = this.screenShake.offsetAt(this.now());
    const shakeDx = shake.dx;
    const shakeDz = -shake.dy;
    this.graph.camera.position.set(focus.x + shakeDx, height, focus.z + shakeDz);
    this.graph.camera.lookAt(focus.x + shakeDx, focus.y, focus.z + shakeDz);
  }
}
