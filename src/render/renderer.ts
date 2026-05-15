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
import { computeGhostState, type GhostState } from "./ghost.js";
import {
  applyHoverBillboards,
  applyLanternBodyUnlit,
  defaultPlayerMeshFactory,
} from "./player_mesh.js";
import { SceneGraph, type Viewport } from "./scene_graph.js";
import { ZoomController, clampZoomHeight } from "./zoom.js";

export type { Viewport } from "./scene_graph.js";

// Day-cycle sun-position radius (mirrors `scene_graph.ts`). The per-frame
// daylight sample places the directional sun at this offset from the
// local-player focus so its world-space angle reads correctly from any
// viewpoint while keeping the shadow camera frustum bounded.
const SUN_DISTANCE = 60;

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
    const entities = composePlayerEntities(this.world, this.buffer, nowMs);
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
    this.graph.camera.position.set(focus.x, height, focus.z);
    this.graph.camera.lookAt(focus);
  }
}
