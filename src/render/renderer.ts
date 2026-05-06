import * as THREE from "three";

import { CAMERA_HEIGHT, PLAYER_RADIUS, ZOOM_OUT_CAMERA_HEIGHT } from "../config.js";
import {
  CHUNK_SIZE,
  paletteColorHex,
  type PlayerId,
  type SnapshotBuffer,
  type Terrain,
  type World,
} from "../game/index.js";
import { tileCenterToScene } from "./terrain.js";
import { composePlayerEntities } from "./compose.js";
import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
  type RenderableEntity,
} from "./sync.js";
import {
  pickBlockUnderCursor,
  pickPlayerUnderCursor,
  type PickResult,
} from "./picker.js";
import { buildChunkMesh, buildTerrainMesh, disposeTerrainMesh } from "./terrain.js";
import {
  EffectsLayer,
  type BlockEditEvent,
  type TargetingStateEvent,
} from "./effects/index.js";

// The player's body sphere mirrors the authoritative collision radius
// (`PLAYER_RADIUS` in `config.ts`, `crate::game::player::PLAYER_RADIUS`
// on the server) so visuals and authority agree on what "touching" means.
const BODY_RADIUS = PLAYER_RADIUS;
const BODY_SEGMENTS = 16;
// Painted face. Eyes are drawn into the body's CanvasTexture instead of
// being separate child meshes — drops two child meshes per player and
// lets future expressions (blinks, emotes) become 2D texture edits with
// no geometry churn. The body sphere's local +X is the player's "front"
// (see `facingToYaw`), which on the default Three.js sphere UV maps to
// the texture's horizontal midpoint, so eyes painted symmetrically
// around `s = 0.5` always sit on the facing-forward hemisphere.
const BODY_TEXTURE_W = 256;
const BODY_TEXTURE_H = 128;
// Eye texture coords derived from the previous child-eye offsets:
// position (0.266, 0.126, ±0.14) projected to the unit sphere then
// converted via the inverse of the default Three.js sphere UV mapping.
// `EYE_T` is the texture's vertical coord (1 - latitude/π, with the
// flipY default making canvas-Y = (1 - t) * H).
const EYE_S_RIGHT = 0.423;
const EYE_S_LEFT = 0.577;
const EYE_T = 0.618;
const EYE_WHITE_RADIUS_PX = 12;
const EYE_PUPIL_RADIUS_PX = 5;
const EYE_WHITE_COLOR = "#ffffff";
const EYE_PUPIL_COLOR = "#101010";

// Username billboard. `BILLBOARD_HEIGHT_OFFSET` is in scene units (Three.js
// Y-up); the sprite parents to the body mesh so it follows the player. The
// sprite uses a `CanvasTexture` of the rendered name so we can choose
// font + outline + size without depending on a Three.js-side font loader.
// The sprite size is sized in world units so it stays readable at default
// camera zoom; sprites by definition always face the camera.
//
// The offset puts the *bottom* of the sprite just above the sphere top:
// sphere top sits at `BODY_RADIUS` above the body center, the sprite is
// anchored at its center with height `BILLBOARD_WORLD_HEIGHT`, so its
// bottom is at `BILLBOARD_HEIGHT_OFFSET - BILLBOARD_WORLD_HEIGHT/2`. We
// keep ~0.025 of clearance so the label feels attached without floating.
const BILLBOARD_WORLD_HEIGHT = 0.45;
const BILLBOARD_HEIGHT_OFFSET = BODY_RADIUS + BILLBOARD_WORLD_HEIGHT / 2 + 0.025;
const BILLBOARD_FONT_PX = 56;
const BILLBOARD_PAD_PX = 12;
const BILLBOARD_TEXT_COLOR = "#ffffff";
const BILLBOARD_OUTLINE_COLOR = "#000000";
const BILLBOARD_OUTLINE_WIDTH = 6;
// Property key on `mesh.userData` where the per-player billboard sprite is
// stashed at create time. The frame loop reads this to toggle visibility
// against the hovered-player id from the cursor picker; gating it through a
// single key lets the sprite stay parented to the body (so it follows
// movement automatically) without exposing a parallel sprite map.
const BILLBOARD_USERDATA_KEY = "usernameBillboard";
const AXIS_HALF_LENGTH = 10000;
const AXIS_Y_OFFSET = 0.01;
const AXIS_X_COLOR = 0xff5050;
const AXIS_Y_COLOR = 0x60a0ff;

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

// Builder-mode placement ghost: a semi-transparent unit-cube preview at the
// targeted top-layer cell. Sized to match a real placed top-layer block
// (`TOP_BOX_*` in `terrain.ts`) so what-you-see is what-you-get on click.
const GHOST_COLOR = 0xf5c542;
const GHOST_OPACITY = 0.45;
const GHOST_BOX_SIZE = 1.0;
const GHOST_BOX_Y = 0.025 + GHOST_BOX_SIZE / 2;

const defaultFactory: PlayerMeshFactory = {
  create(entity: RenderableEntity, _isLocal: boolean) {
    const bodyGeom = new THREE.SphereGeometry(
      BODY_RADIUS,
      BODY_SEGMENTS,
      BODY_SEGMENTS,
    );
    // The body color is the player's lobby palette pick; both local and
    // remote players are tinted the same way (the local player is
    // distinguishable by camera follow + their own billboard).
    const bodyMat = buildBodyMaterial(paletteColorHex(entity.colorIndex));
    const body = new THREE.Mesh(bodyGeom, bodyMat);

    if (entity.username.length > 0) {
      const billboard = buildUsernameBillboard(entity.username);
      // Hidden by default — the renderer's per-frame hover pass flips
      // `visible` for whichever body is under the cursor.
      billboard.visible = false;
      body.userData[BILLBOARD_USERDATA_KEY] = billboard;
      body.add(billboard);
    }

    return body;
  },
};

/**
 * Build the body material with eyes painted into a `CanvasTexture` mapped
 * onto the sphere. Falls back to a flat-color material when no 2D canvas
 * context is available (headless test envs); the body still renders, just
 * without eyes — matching the renderer's prior fault-tolerant style for
 * the username billboard.
 */
function buildBodyMaterial(bodyColorHex: number): THREE.MeshLambertMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = BODY_TEXTURE_W;
  canvas.height = BODY_TEXTURE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.MeshLambertMaterial({ color: bodyColorHex });

  const r = (bodyColorHex >> 16) & 0xff;
  const g = (bodyColorHex >> 8) & 0xff;
  const b = bodyColorHex & 0xff;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, BODY_TEXTURE_W, BODY_TEXTURE_H);

  // CanvasTexture defaults to flipY = true, so canvas y = (1 - t) * H
  // for a target texture coord t.
  const eyeY = (1 - EYE_T) * BODY_TEXTURE_H;
  for (const s of [EYE_S_LEFT, EYE_S_RIGHT]) {
    const cx = s * BODY_TEXTURE_W;
    ctx.fillStyle = EYE_WHITE_COLOR;
    ctx.beginPath();
    ctx.arc(cx, eyeY, EYE_WHITE_RADIUS_PX, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = EYE_PUPIL_COLOR;
    ctx.beginPath();
    ctx.arc(cx, eyeY, EYE_PUPIL_RADIUS_PX, 0, 2 * Math.PI);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return new THREE.MeshLambertMaterial({ map: texture });
}

/**
 * Render the username into an offscreen 2D canvas and wrap it as a
 * `THREE.Sprite` so it always faces the camera. The sprite parents to the
 * body so it follows the player; world height is fixed in scene units so
 * the label stays readable at default zoom regardless of canvas pixel
 * density. The body mesh is yawed each frame to track the player's facing,
 * so the sprite is parented to a wrapper that we counter-rotate inverse to
 * the body — without that, the billboard would orbit the body whenever the
 * player turned. Sprites already cancel rotation against the camera, but
 * the parent transform applies before that, hence the wrapper.
 */
function buildUsernameBillboard(username: string): THREE.Object3D {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Headless / no-2d-canvas fallback — return an empty group rather
    // than crashing. The renderer-level tests stub `THREE` and never see
    // this path, but defensive rendering keeps a missing 2d ctx visible
    // as "no name above head" rather than a thrown exception.
    return new THREE.Group();
  }
  ctx.font = `${BILLBOARD_FONT_PX}px system-ui, sans-serif`;
  const metrics = ctx.measureText(username);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = BILLBOARD_FONT_PX;
  canvas.width = textWidth + BILLBOARD_PAD_PX * 2;
  canvas.height = textHeight + BILLBOARD_PAD_PX * 2;
  // Re-set font after the canvas resize (mutating width/height resets ctx).
  ctx.font = `${BILLBOARD_FONT_PX}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = BILLBOARD_OUTLINE_WIDTH;
  ctx.strokeStyle = BILLBOARD_OUTLINE_COLOR;
  ctx.fillStyle = BILLBOARD_TEXT_COLOR;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.strokeText(username, cx, cy);
  ctx.fillText(username, cx, cy);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  // The body counter-rotates with facing (see `syncPlayerMeshes`); wrap the
  // sprite in a group so we can compensate for the body's local Y rotation
  // each frame in `Renderer.frame` if needed. Today the sprite parent is
  // the body itself, but Sprite always faces the camera in world space, so
  // the body's yaw is irrelevant for the sprite's orientation — the offset
  // position is what we care about, and that's a Z-up offset in body-local
  // space that we set once.
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(BILLBOARD_WORLD_HEIGHT * aspect, BILLBOARD_WORLD_HEIGHT, 1);
  sprite.position.set(0, BILLBOARD_HEIGHT_OFFSET, 0);
  // Render on top so the label isn't hidden by the body sphere when the
  // player is partially behind a top-layer block.
  sprite.renderOrder = 999;
  return sprite;
}

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
  private ghostMesh: THREE.Mesh | null = null;
  private readonly effects: EffectsLayer;
  private readonly chunkBorderGrid: THREE.LineSegments;
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
    factory: PlayerMeshFactory = defaultFactory,
    now: () => number = () => Date.now(),
  ) {
    this.terrain = terrain;
    this.factory = factory;
    this.now = now;

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
    container.appendChild(this.webgl.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(6, 12, 4);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshLambertMaterial({ color: 0x2a4d2a }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

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

    if (terrain !== null) {
      this.terrainGroup = buildTerrainMesh(terrain);
      this.scene.add(this.terrainGroup);
    }

    // Effects layer (task 070): place pulses, break shatters, and held-
    // break targeting overlays. Tinted by the actor's lobby color via the
    // `World`-backed lookup; players unknown to the local snapshot fall
    // back to palette[0] (the layer handles the missing-player path).
    this.effects = new EffectsLayer((id) => {
      const player = this.world.getPlayer(id);
      return player ? player.colorIndex : null;
    });
    this.scene.add(this.effects.scene());

    this.chunkBorderGrid = buildChunkBorderGrid();
    this.chunkBorderGrid.visible = false;
    this.scene.add(this.chunkBorderGrid);

    this.webgl.setAnimationLoop(this.frame);
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
   * top-down camera floats at `ZOOM_OUT_CAMERA_HEIGHT` instead of
   * `CAMERA_HEIGHT` and the chunk-border grid is shown. Instant snap; no
   * animation. The grid is parked in the scene at construction time so
   * toggling is just a `visible` flip — no allocation, no draw-call churn.
   */
  setZoomedOut(on: boolean): void {
    if (this.zoomedOut === on) return;
    this.zoomedOut = on;
    this.chunkBorderGrid.visible = on;
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
   * Show or hide the builder-mode placement ghost. Pass a tile address to
   * pin a translucent gold preview at that cell, or `null` to hide it. The
   * caller (input layer) is responsible for deciding whether the ghost
   * should be visible — this method just paints the result. The underlying
   * mesh is reused across calls (only `visible` and position change) so a
   * fast-flapping ghost on a tight refresh loop doesn't churn GPU resources.
   */
  setGhostCell(
    cell: readonly [number, number, number, number] | null,
  ): void {
    if (cell === null) {
      if (this.ghostMesh) this.ghostMesh.visible = false;
      return;
    }
    if (!this.ghostMesh) {
      const geom = new THREE.BoxGeometry(
        GHOST_BOX_SIZE,
        GHOST_BOX_SIZE,
        GHOST_BOX_SIZE,
      );
      const mat = new THREE.MeshLambertMaterial({
        color: GHOST_COLOR,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false,
      });
      this.ghostMesh = new THREE.Mesh(geom, mat);
      this.scene.add(this.ghostMesh);
    }
    const [cx, cy, lx, ly] = cell;
    const scene = tileCenterToScene(cx, cy, lx, ly);
    this.ghostMesh.position.set(scene.x, GHOST_BOX_Y, scene.z);
    this.ghostMesh.visible = true;
  }

  /**
   * The wire layer just observed a per-tick block-edit (place / break)
   * attributed to a player. Spawns a one-shot effect at the cell tinted
   * by the actor's color. See `EffectsLayer.onBlockEdit`.
   */
  onBlockEdit(event: BlockEditEvent): void {
    this.effects.onBlockEdit(event, this.now());
  }

  /**
   * The wire layer just observed this tick's full set of held-break
   * targeting states. Replaces the live targeting overlays wholesale.
   */
  applyTargetingStates(targets: readonly TargetingStateEvent[]): void {
    this.effects.applyTargets(targets);
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
    root.add(buildChunkMesh(cx, cy, chunk));
  }

  /**
   * The wire layer just removed the chunk at `(cx, cy)`. Drop its
   * sub-group from the terrain mesh.
   */
  applyChunkUnloaded(cx: number, cy: number): void {
    if (!this.terrainGroup) return;
    this.disposeChunkSubgroup(cx, cy, this.terrainGroup);
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
    if (this.ghostMesh) {
      this.scene.remove(this.ghostMesh);
      this.ghostMesh.geometry.dispose();
      (this.ghostMesh.material as THREE.Material).dispose();
      this.ghostMesh = null;
    }
    this.effects.dispose();
    this.scene.remove(this.chunkBorderGrid);
    this.chunkBorderGrid.geometry.dispose();
    (this.chunkBorderGrid.material as THREE.Material).dispose();
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
    this.refreshHoverBillboards();
    this.effects.update(nowMs);
    this.webgl.render(this.scene, this.camera);
  };

  private refreshHoverBillboards(): void {
    // The picker uses `Raycaster.intersectObjects` which respects camera
    // matrices computed during the previous render — `updateCamera` has
    // already run this frame, so the picker sees the current view.
    const hoveredId =
      this.cursorNdc === null
        ? null
        : pickPlayerUnderCursor(this.cursorNdc, this.camera, this.meshes);
    for (const [id, mesh] of this.meshes) {
      const billboard = mesh.userData[BILLBOARD_USERDATA_KEY] as
        | THREE.Object3D
        | undefined;
      if (!billboard) continue;
      billboard.visible = id === hoveredId;
    }
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
    const height = this.zoomedOut ? ZOOM_OUT_CAMERA_HEIGHT : CAMERA_HEIGHT;
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
