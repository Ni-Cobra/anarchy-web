import * as THREE from "three";

import { CAMERA_HEIGHT } from "../config.js";
import type {
  PlayerId,
  SnapshotBuffer,
  Terrain,
  World,
} from "../game/index.js";
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

const LOCAL_COLOR = 0xff3030;
const REMOTE_COLOR = 0x1e90ff;
const EYE_COLOR = 0xffffff;
const BODY_RADIUS = 0.5;
const BODY_SEGMENTS = 16;
const EYE_RADIUS = 0.09;
const EYE_SEGMENTS = 6;
const EYE_FORWARD = 0.38;
const EYE_UP = 0.18;
const EYE_SIDE = 0.2;
const AXIS_HALF_LENGTH = 10000;
const AXIS_Y_OFFSET = 0.01;
const AXIS_X_COLOR = 0xff5050;
const AXIS_Y_COLOR = 0x60a0ff;

const defaultFactory: PlayerMeshFactory = {
  create(_entity: RenderableEntity, isLocal: boolean) {
    const bodyGeom = new THREE.SphereGeometry(
      BODY_RADIUS,
      BODY_SEGMENTS,
      BODY_SEGMENTS,
    );
    const bodyMat = new THREE.MeshLambertMaterial({
      color: isLocal ? LOCAL_COLOR : REMOTE_COLOR,
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

    return body;
  },
};

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
