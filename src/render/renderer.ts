import * as THREE from "three";

import {
  CAMERA_HEIGHT,
  ZOOM_OUT_CAMERA_HEIGHT,
  ZOOM_STEP_FACTOR,
  ZOOM_TWEEN_MS,
} from "../config.js";
import {
  CHUNK_SIZE,
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
import {
  buildChunkMesh,
  buildTerrainMesh,
  disposeTerrainMesh,
  tileCenterToScene,
  torchPositionsInChunk,
} from "./terrain.js";
import { sampleDaylight } from "./daylight.js";
import { TorchLights } from "./torch_lights.js";
import { LanternLights } from "./lantern_lights.js";
import {
  BeamLayer,
  BreakParticles,
  defaultBreakParticleColor,
  EffectsLayer,
  type BlockEditEvent,
  type TargetingStateEvent,
} from "./effects/index.js";
import { computeGhostState, type GhostState } from "./ghost.js";
import { GhostMesh } from "./ghost_mesh.js";
import {
  applyHoverBillboards,
  applyLanternBodyUnlit,
  defaultPlayerMeshFactory,
} from "./player_mesh.js";
import { ZoomController, clampZoomHeight } from "./zoom.js";
import {
  type BlockTextureSet,
  disposeBlockTextures,
  loadBlockTextures,
} from "./texture_loader.js";

const AXIS_HALF_LENGTH = 10000;
const AXIS_Y_OFFSET = 0.01;
const AXIS_X_COLOR = 0xff5050;
const AXIS_Y_COLOR = 0x60a0ff;

// Day-cycle directional sun (task 310). The sun sits on a sphere of this
// radius around the camera focus so its world-space angle reads correctly
// from any viewpoint while keeping the shadow camera frustum bounded. The
// shadow camera is a square orthographic frustum sized to the camera's
// reach — bigger than the visible window so blocks just past the edge can
// still cast into it.
const SUN_DISTANCE = 60;
const SHADOW_HALF_EXTENT = 50;
const SHADOW_MAP_SIZE = 1024;

// Chunk-border debug overlay (only visible in zoom-out mode). The grid
// covers a fixed bounded region in world coords — large enough that the
// local player can't walk off the edge in a normal session — and uses a
// single `LineSegments` mesh so the whole grid is one draw call regardless
// of the line count. Y offset sits a hair above the world axis so the
// grid doesn't z-fight with the axis lines on platforms that don't write
// stable depth for line primitives.
const CHUNK_GRID_HALF_CHUNKS = 64;
const CHUNK_GRID_HALF = CHUNK_GRID_HALF_CHUNKS * CHUNK_SIZE;
const CHUNK_GRID_Y_OFFSET = AXIS_Y_OFFSET + 0.005;
const CHUNK_GRID_COLOR = 0xa0a0a0;
const CHUNK_GRID_OPACITY = 0.35;

/**
 * Initial viewport state passed in from the caller. Keeps the renderer
 * free of `window` queries so DOM access stays in `main.ts`.
 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

/**
 * Owns the Three.js scene + render loop. Per ADR 0003 every player —
 * local and remote — renders from `SnapshotBuffer` with the same
 * `REMOTE_RENDER_DELAY_MS` interpolation delay; `LocalPredictor` was
 * retired with the chunk-centric refactor. Local input now feels the
 * server tick, which is the known regression until a future task
 * reintroduces prediction.
 *
 * The renderer is networking- and DOM-agnostic: the caller supplies a
 * container element, an initial `Viewport`, and is responsible for
 * forwarding window resizes via `resize()`. The wire layer feeds `World`
 * / `SnapshotBuffer` / `Terrain` and tells us who we are with
 * `setLocalPlayerId`.
 */
export class Renderer {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly webgl: THREE.WebGLRenderer;
  private readonly playerGroup: THREE.Group;
  private readonly meshes = new Map<PlayerId, THREE.Mesh>();
  private readonly factory: PlayerMeshFactory;
  private readonly now: () => number;
  private localPlayerId: PlayerId | null = null;
  private terrain: Terrain | null;
  private terrainGroup: THREE.Group | null = null;
  private readonly blockTextures: BlockTextureSet;
  private readonly ghost: GhostMesh;
  private readonly inventory: Inventory | null;
  private readonly getSelectedHotbarSlot: () => number;
  private readonly effects: EffectsLayer;
  private readonly beams: BeamLayer;
  private readonly breakParticles: BreakParticles;
  private readonly chunkBorderGrid: THREE.LineSegments;
  // Day-cycle lights (task 310). Both update each frame from the server-
  // authoritative `time_of_day_seconds` scalar; intensity, colour, and the
  // sun's world position all derive from `sampleDaylight`.
  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly ground: THREE.Mesh;
  // Per-torch point-light pool (task 350). Tracks Torch positions per
  // loaded chunk and per-frame illuminates the 32 nearest around the
  // local player at intensity scaled by the day-cycle's `nightFactor`.
  private readonly torchLights: TorchLights;
  // Per-player lantern-light pool (task 370). One warm point light per
  // visible player whose `equippedUtility` is `ItemId.Lantern`, pinned
  // at head height and moved each frame to track their position. Scales
  // with the same `nightFactor` as the torches so day reads dark.
  private readonly lanternLights: LanternLights;
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

    this.blockTextures = loadBlockTextures();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202028);

    this.camera = new THREE.PerspectiveCamera(
      60,
      viewport.width / viewport.height,
      0.1,
      1000,
    );
    this.camera.up.set(0, 0, -1);

    this.webgl = new THREE.WebGLRenderer({ antialias: true });
    this.webgl.setPixelRatio(viewport.pixelRatio);
    this.webgl.setSize(viewport.width, viewport.height);
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.webgl.domElement);

    // Day-cycle lights (task 310). Plain values set here are placeholders;
    // the per-frame `updateDaylight` resamples colour + intensity + sun
    // position every frame from the synced `time_of_day_seconds`.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const shadowCam = this.sun.shadow.camera as THREE.OrthographicCamera;
    shadowCam.left = -SHADOW_HALF_EXTENT;
    shadowCam.right = SHADOW_HALF_EXTENT;
    shadowCam.top = SHADOW_HALF_EXTENT;
    shadowCam.bottom = -SHADOW_HALF_EXTENT;
    shadowCam.near = 0.5;
    shadowCam.far = SUN_DISTANCE * 2 + SHADOW_HALF_EXTENT;
    shadowCam.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshLambertMaterial({ color: 0x2a4d2a }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.scene.add(
      buildAxisLine(
        new THREE.Vector3(-AXIS_HALF_LENGTH, AXIS_Y_OFFSET, 0),
        new THREE.Vector3(AXIS_HALF_LENGTH, AXIS_Y_OFFSET, 0),
        AXIS_X_COLOR,
      ),
    );
    this.scene.add(
      buildAxisLine(
        new THREE.Vector3(0, AXIS_Y_OFFSET, -AXIS_HALF_LENGTH),
        new THREE.Vector3(0, AXIS_Y_OFFSET, AXIS_HALF_LENGTH),
        AXIS_Y_COLOR,
      ),
    );

    this.playerGroup = new THREE.Group();
    this.scene.add(this.playerGroup);

    this.torchLights = new TorchLights();
    this.scene.add(this.torchLights.scene());

    this.lanternLights = new LanternLights();
    this.scene.add(this.lanternLights.scene());

    if (terrain !== null) {
      this.terrainGroup = buildTerrainMesh(terrain, this.blockTextures);
      this.scene.add(this.terrainGroup);
      // Seed the torch-light layer from any chunks that came in with the
      // initial terrain — `applyChunkLoaded` is the steady-state path, but
      // construction with a non-null terrain bypasses it.
      for (const [coord, chunk] of terrain.iter()) {
        this.torchLights.setChunkTorches(
          coord[0],
          coord[1],
          torchPositionsInChunk(coord[0], coord[1], chunk),
        );
      }
    }

    this.ghost = new GhostMesh(this.scene, this.blockTextures);

    // Effects layer (task 070): place pulses, break shatters, and held-
    // break targeting overlays. Tinted by the actor's lobby color via the
    // `World`-backed lookup; players unknown to the local snapshot fall
    // back to palette[0] (the layer handles the missing-player path).
    this.effects = new EffectsLayer((id) => {
      const player = this.world.getPlayer(id);
      return player ? player.colorIndex : null;
    });
    this.scene.add(this.effects.scene());

    // Beam layer (task 030): visual line connecting an actor to the cell
    // they're acting on. Driven by the same wire signals as the effects
    // layer (held-break targeting + place edits) plus per-frame player
    // positions plumbed by `frame()` so the beam tracks moving actors.
    this.beams = new BeamLayer();
    this.scene.add(this.beams.scene());

    // Break-particle puff (task 125): tinted shards scatter from the cell
    // the moment a block transitions to Air. The wire layer feeds the
    // same `BlockEdit` events the effects layer consumes; we cherry-pick
    // the broken ones here.
    this.breakParticles = new BreakParticles(defaultBreakParticleColor);
    this.scene.add(this.breakParticles.scene());

    this.chunkBorderGrid = buildChunkBorderGrid();
    this.chunkBorderGrid.visible = false;
    this.scene.add(this.chunkBorderGrid);

    this.zoom = new ZoomController(CAMERA_HEIGHT, ZOOM_TWEEN_MS, this.now());

    this.webgl.setAnimationLoop(this.frame);
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
      disposePlayerMesh(mesh, this.playerGroup);
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
    this.chunkBorderGrid.visible = on;
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
    return pickBlockUnderCursor(cursorNdc, this.camera, this.terrain);
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
    return this.ghost.getState();
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
    return this.lanternLights.visibleCount();
  }

  /**
   * The wire layer just observed a per-tick block-edit (place / break)
   * attributed to a player. Spawns a one-shot effect at the cell tinted
   * by the actor's color. See `EffectsLayer.onBlockEdit`.
   */
  onBlockEdit(event: BlockEditEvent): void {
    const nowMs = this.now();
    this.effects.onBlockEdit(event, nowMs);
    if (event.kind === "placed") {
      this.beams.onPlace(event, nowMs);
    } else {
      const center = tileCenterToScene(event.cx, event.cy, event.lx, event.ly);
      this.breakParticles.spawn(center.x, center.z, event.blockType, nowMs);
    }
  }

  /**
   * The wire layer just observed this tick's full set of held-break
   * targeting states. Replaces the live targeting overlays wholesale.
   */
  applyTargetingStates(targets: readonly TargetingStateEvent[]): void {
    this.effects.applyTargets(targets);
    this.beams.applyBreakTargets(targets);
  }

  /**
   * The wire layer just inserted or replaced the chunk at `(cx, cy)`.
   * Replace just that chunk's sub-group inside the terrain mesh, leaving
   * neighbors untouched.
   */
  applyChunkLoaded(cx: number, cy: number): void {
    if (!this.terrain) return;
    const chunk = this.terrain.get(cx, cy);
    if (!chunk) return;
    const root = this.terrainGroupOrCreate();
    this.disposeChunkSubgroup(cx, cy, root);
    root.add(buildChunkMesh(cx, cy, chunk, this.blockTextures, this.terrain));
    this.torchLights.setChunkTorches(
      cx,
      cy,
      torchPositionsInChunk(cx, cy, chunk),
    );
  }

  /**
   * The wire layer just removed the chunk at `(cx, cy)`. Drop its
   * sub-group from the terrain mesh.
   */
  applyChunkUnloaded(cx: number, cy: number): void {
    if (!this.terrainGroup) return;
    this.disposeChunkSubgroup(cx, cy, this.terrainGroup);
    this.torchLights.removeChunk(cx, cy);
  }

  private terrainGroupOrCreate(): THREE.Group {
    if (this.terrainGroup) return this.terrainGroup;
    const g = new THREE.Group();
    g.name = "terrain";
    this.scene.add(g);
    this.terrainGroup = g;
    return g;
  }

  private disposeChunkSubgroup(
    cx: number,
    cy: number,
    root: THREE.Group,
  ): void {
    const name = `chunk:${cx},${cy}`;
    const existing = root.children.find((c) => c.name === name);
    if (!existing) return;
    disposeTerrainMesh(existing, root);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.webgl.setSize(width, height);
  }

  dispose(): void {
    this.webgl.setAnimationLoop(null);
    for (const mesh of this.meshes.values()) {
      disposePlayerMesh(mesh, this.playerGroup);
    }
    this.meshes.clear();
    if (this.terrainGroup) {
      disposeTerrainMesh(this.terrainGroup, this.scene);
      this.terrainGroup = null;
    }
    this.ghost.dispose();
    this.effects.dispose();
    this.beams.dispose();
    this.breakParticles.dispose();
    this.torchLights.dispose();
    this.scene.remove(this.torchLights.scene());
    this.lanternLights.dispose();
    this.scene.remove(this.lanternLights.scene());
    this.scene.remove(this.chunkBorderGrid);
    this.chunkBorderGrid.geometry.dispose();
    (this.chunkBorderGrid.material as THREE.Material).dispose();
    disposeBlockTextures(this.blockTextures);
    this.webgl.dispose();
    this.webgl.domElement.remove();
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
      this.playerGroup,
      this.factory,
      dtMs,
    );
    this.updateCamera(entities);
    this.updateDaylight(entities);
    applyLanternBodyUnlit(this.meshes, entities);
    this.refreshHoverBillboards();
    this.refreshGhostPreview();
    this.effects.update(nowMs);
    this.breakParticles.update(nowMs);
    // Beams aim at the same interpolated player positions that
    // `syncPlayerMeshes` just consumed so a beam stays glued to its
    // actor's body across remote-render delay.
    const positionByPlayer = new Map<PlayerId, { x: number; y: number }>();
    for (const e of entities) positionByPlayer.set(e.id, { x: e.x, y: e.y });
    this.beams.update((id) => positionByPlayer.get(id) ?? null, nowMs);
    this.webgl.render(this.scene, this.camera);
  };

  private refreshGhostPreview(): void {
    if (this.inventory === null || this.terrain === null) {
      this.ghost.apply(null);
      return;
    }
    const slot = this.inventory.slot(this.getSelectedHotbarSlot());
    const pick =
      this.cursorNdc === null
        ? null
        : pickBlockUnderCursor(this.cursorNdc, this.camera, this.terrain);
    const state = computeGhostState({
      slot,
      pick,
      world: this.world,
      terrain: this.terrain,
      localPlayerId: this.localPlayerId,
    });
    this.ghost.apply(state);
  }

  private refreshHoverBillboards(): void {
    // The picker uses `Raycaster.intersectObjects` which respects camera
    // matrices computed during the previous render — `updateCamera` has
    // already run this frame, so the picker sees the current view.
    const hoveredId =
      this.cursorNdc === null
        ? null
        : pickPlayerUnderCursor(this.cursorNdc, this.camera, this.meshes);
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
    this.ambient.color.setHex(sample.ambientColor);
    this.ambient.intensity = sample.ambientIntensity;
    this.sun.color.setHex(sample.sunColor);
    this.sun.intensity = sample.sunIntensity;
    (this.scene.background as THREE.Color).setHex(sample.skyColor);

    const local =
      this.localPlayerId !== null
        ? entities.find((e) => e.id === this.localPlayerId)
        : undefined;
    const focus = local
      ? tileToScene(local.x, local.y)
      : new THREE.Vector3(0, 0, 0);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      focus.x + sample.sunDir.x * SUN_DISTANCE,
      focus.y + sample.sunDir.y * SUN_DISTANCE,
      focus.z + sample.sunDir.z * SUN_DISTANCE,
    );
    // The shadow map is computed in the sun's local frame, which derives
    // from `sun.position` + `sun.target.position`. Telling Three.js to
    // refresh the shadow camera matrix every frame is cheap (one matrix
    // multiply) and avoids ghost-shadows from a stale frustum.
    this.sun.shadow.camera.updateProjectionMatrix();
    // Torches (task 350): light-pool driven by the same daylight sample
    // and the same focus point as the sun. Pinning the focus to the local
    // player keeps the "32 nearest torches" pick stable as the world
    // streams in around them.
    this.torchLights.update({ x: focus.x, z: focus.z }, sample.nightFactor);
    // Lanterns (task 370): one light per player wearing one. Driven by
    // the same `nightFactor` so the day cycle reads consistent across
    // every warm light source.
    this.lanternLights.update(entities, sample.nightFactor);
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
    this.camera.position.set(focus.x, height, focus.z);
    this.camera.lookAt(focus);
  }
}

function buildAxisLine(
  from: THREE.Vector3,
  to: THREE.Vector3,
  color: number,
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({ color });
  return new THREE.Line(geometry, material);
}

/**
 * Build a single `LineSegments` mesh holding every chunk-border line in a
 * fixed bounded region around the world origin. World coords map to scene
 * with `(+x_world, +y_world) → (+x_scene, -z_scene)` (mirroring
 * `tileCenterToScene`), so a vertical world-space line at `world_x = k`
 * becomes a constant-`scene_x` segment varying in scene Z.
 */
function buildChunkBorderGrid(): THREE.LineSegments {
  const positions: number[] = [];
  for (let i = -CHUNK_GRID_HALF_CHUNKS; i <= CHUNK_GRID_HALF_CHUNKS; i++) {
    const k = i * CHUNK_SIZE;
    positions.push(k, CHUNK_GRID_Y_OFFSET, -CHUNK_GRID_HALF);
    positions.push(k, CHUNK_GRID_Y_OFFSET, CHUNK_GRID_HALF);
    positions.push(-CHUNK_GRID_HALF, CHUNK_GRID_Y_OFFSET, -k);
    positions.push(CHUNK_GRID_HALF, CHUNK_GRID_Y_OFFSET, -k);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: CHUNK_GRID_COLOR,
    transparent: true,
    opacity: CHUNK_GRID_OPACITY,
  });
  return new THREE.LineSegments(geometry, material);
}
