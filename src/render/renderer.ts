import * as THREE from "three";

import { CAMERA_HEIGHT } from "../config.js";
import type {
  LocalPredictor,
  Player,
  PlayerId,
  SnapshotBuffer,
  World,
} from "../game/index.js";
import { composePlayerEntities } from "./compose.js";
import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
} from "./sync.js";

const LOCAL_COLOR = 0xff3030;
const REMOTE_COLOR = 0x1e90ff;
const CUBE_SIZE = 1;
// Half-length of each ground axis line. Lines extend from -AXIS_HALF_LENGTH to
// +AXIS_HALF_LENGTH along their respective axis; the camera-far clip (1000)
// then bounds what's actually visible from the player's vantage point.
const AXIS_HALF_LENGTH = 10000;
// Tiny lift off the ground plane so axis lines aren't z-fought to death.
const AXIS_Y_OFFSET = 0.01;
const AXIS_X_COLOR = 0xff5050;
const AXIS_Y_COLOR = 0x60a0ff;

const defaultFactory: PlayerMeshFactory = {
  create(_player: Player, isLocal: boolean) {
    const geometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
    const material = new THREE.MeshLambertMaterial({
      color: isLocal ? LOCAL_COLOR : REMOTE_COLOR,
    });
    return new THREE.Mesh(geometry, material);
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
 * Owns the Three.js scene + render loop. Each frame it composes a list of
 * renderable entities — remote players from the lerp output of
 * `SnapshotBuffer` (with `REMOTE_RENDER_DELAY_MS` of delay), the local
 * player from `LocalPredictor` (advancing at `SPEED * dt` so input feels
 * immediate) — and reconciles meshes against it. The camera tracks the
 * local player at its predicted position so the follow stays smooth at
 * the browser frame rate even though snapshots only land at the 20 Hz
 * server cadence.
 *
 * The renderer is networking- and DOM-agnostic: the caller supplies a
 * container element, an initial `Viewport`, and is responsible for
 * forwarding window resizes via `resize()`. The wire layer feeds `World` /
 * `SnapshotBuffer` / `LocalPredictor` and tells us who we are with
 * `setLocalPlayerId`. Nothing here knows about WebSockets or protobuf.
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

  constructor(
    private readonly world: World,
    private readonly buffer: SnapshotBuffer,
    private readonly predictor: LocalPredictor,
    container: HTMLElement,
    viewport: Viewport,
    factory: PlayerMeshFactory = defaultFactory,
    now: () => number = () => Date.now(),
  ) {
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
    // Top-down view: camera looks straight down +y axis. Force the camera's
    // own "up" to point along -z so server north (which we map to scene -z)
    // renders as screen up — without this, lookAt is degenerate when the
    // look direction is parallel to the default up vector.
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

    // Reference axis lines through the world origin. Server +x (east) runs
    // along scene +x; server +y (north) maps to scene -z (see tileToScene).
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

    this.webgl.setAnimationLoop(this.frame);
  }

  /**
   * Tell the renderer which player id is "us". Affects mesh color and the
   * camera-follow target. Pass `null` to clear (e.g. on disconnect). If the
   * id changes, any mesh already built under the old role is dropped so the
   * next frame rebuilds it with the right color.
   */
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

  /**
   * Forward a viewport size change. The caller (typically `main.ts`)
   * subscribes to `window.resize` and pipes the new dimensions through here
   * — keeping this module free of direct `window` access.
   */
  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.webgl.setSize(width, height);
  }

  /** Tear down GPU resources. Call when the page is leaving. */
  dispose(): void {
    this.webgl.setAnimationLoop(null);
    for (const mesh of this.meshes.values()) {
      disposePlayerMesh(mesh, this.playerGroup);
    }
    this.meshes.clear();
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }

  private frame = () => {
    const entities = composePlayerEntities(
      this.world,
      this.buffer,
      this.localPlayerId,
      this.localPlayerId !== null ? this.predictor : null,
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
    // Follow the *predicted* local position so the camera moves at the
    // browser frame rate rather than stepping at the 20 Hz snapshot cadence.
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
