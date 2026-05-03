import * as THREE from "three";

import { CAMERA_HEIGHT, PLAYER_RADIUS } from "../config.js";
import {
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
import { pickBlockUnderCursor, type PickResult } from "./picker.js";
import { buildChunkMesh, buildTerrainMesh, disposeTerrainMesh } from "./terrain.js";

const EYE_COLOR = 0xffffff;
// The player's body sphere mirrors the authoritative collision radius
// (`PLAYER_RADIUS` in `config.ts`, `crate::game::player::PLAYER_RADIUS`
// on the server) so visuals and authority agree on what "touching" means.
const BODY_RADIUS = PLAYER_RADIUS;
const BODY_SEGMENTS = 16;
// Eye geometry + offsets scale with the body so the face stays in
// proportion (0.7 of the old AABB-era values).
const EYE_RADIUS = 0.063;
const EYE_SEGMENTS = 6;
const EYE_FORWARD = 0.266;
const EYE_UP = 0.126;
const EYE_SIDE = 0.14;

// Username billboard. `BILLBOARD_HEIGHT_OFFSET` is in scene units (Three.js
// Y-up); the sprite parents to the body mesh so it follows the player. The
// sprite uses a `CanvasTexture` of the rendered name so we can choose
// font + outline + size without depending on a Three.js-side font loader.
// The sprite size is sized in world units so it stays readable at default
// camera zoom; sprites by definition always face the camera.
const BILLBOARD_HEIGHT_OFFSET = BODY_RADIUS + 0.4;
const BILLBOARD_FONT_PX = 56;
const BILLBOARD_PAD_PX = 12;
const BILLBOARD_WORLD_HEIGHT = 0.45;
const BILLBOARD_TEXT_COLOR = "#ffffff";
const BILLBOARD_OUTLINE_COLOR = "#000000";
const BILLBOARD_OUTLINE_WIDTH = 6;
const AXIS_HALF_LENGTH = 10000;
const AXIS_Y_OFFSET = 0.01;
const AXIS_X_COLOR = 0xff5050;
const AXIS_Y_COLOR = 0x60a0ff;

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
    const bodyMat = new THREE.MeshLambertMaterial({
      color: paletteColorHex(entity.colorIndex),
    });
    const body = new THREE.Mesh(bodyGeom, bodyMat);

    const eyeGeom = new THREE.SphereGeometry(
      EYE_RADIUS,
      EYE_SEGMENTS,
      EYE_SEGMENTS,
    );
    const eyeMat = new THREE.MeshLambertMaterial({ color: EYE_COLOR });
    const leftEye = new THREE.Mesh(eyeGeom, eyeMat);
    leftEye.position.set(EYE_FORWARD, EYE_UP, -EYE_SIDE);
    const rightEye = new THREE.Mesh(eyeGeom, eyeMat);
    rightEye.position.set(EYE_FORWARD, EYE_UP, EYE_SIDE);
    body.add(leftEye, rightEye);

    if (entity.username.length > 0) {
      body.add(buildUsernameBillboard(entity.username));
    }

    return body;
  },
};

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
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }

  private frame = () => {
    const entities = composePlayerEntities(
      this.world,
      this.buffer,
      this.now(),
    );
    syncPlayerMeshes(
      entities,
      this.localPlayerId,
      this.meshes,
      this.playerGroup,
      this.factory,
    );
    this.updateCamera(entities);
    this.webgl.render(this.scene, this.camera);
  };

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
    this.camera.position.set(focus.x, CAMERA_HEIGHT, focus.z);
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
