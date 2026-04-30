import * as THREE from "three";

import type { Player, PlayerId, SnapshotBuffer, World } from "../game/index.js";
import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
  type RenderableEntity,
} from "./sync.js";

const LOCAL_COLOR = 0xff3030;
const REMOTE_COLOR = 0x1e90ff;
const CUBE_SIZE = 1;
const CAMERA_HEIGHT = 14;

/**
 * Render-time delay applied to remote players. Per ADR 0001 we draw remote
 * cubes ~100 ms behind real time and lerp between bracketing snapshots, so
 * a typical jitter or a single dropped tick never produces a visible jump.
 * The local player ignores this delay and reads the latest authoritative
 * position directly off `World`.
 */
export const REMOTE_RENDER_DELAY_MS = 100;

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
 * Owns the Three.js scene + render loop. Each frame it composes a list of
 * renderable entities — the local player at its latest server-authoritative
 * position, every remote player at the lerp output of `SnapshotBuffer` —
 * and reconciles meshes against it. The camera tracks the local player.
 *
 * The renderer is networking-agnostic: a wire layer feeds `World` /
 * `SnapshotBuffer` and tells us who we are with `setLocalPlayerId`. Nothing
 * here knows about WebSockets or protobuf.
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
    container: HTMLElement = document.body,
    factory: PlayerMeshFactory = defaultFactory,
    now: () => number = () => Date.now(),
  ) {
    this.factory = factory;
    this.now = now;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202028);

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    // Top-down view: camera looks straight down +y axis. Force the camera's
    // own "up" to point along -z so server north (which we map to scene -z)
    // renders as screen up — without this, lookAt is degenerate when the
    // look direction is parallel to the default up vector.
    this.camera.up.set(0, 0, -1);

    this.webgl = new THREE.WebGLRenderer({ antialias: true });
    this.webgl.setPixelRatio(window.devicePixelRatio);
    this.webgl.setSize(window.innerWidth, window.innerHeight);
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

    this.playerGroup = new THREE.Group();
    this.scene.add(this.playerGroup);

    window.addEventListener("resize", this.handleResize);
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

  /** Tear down listeners + GPU resources. Call when the page is leaving. */
  dispose(): void {
    this.webgl.setAnimationLoop(null);
    window.removeEventListener("resize", this.handleResize);
    for (const mesh of this.meshes.values()) {
      disposePlayerMesh(mesh, this.playerGroup);
    }
    this.meshes.clear();
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }

  private handleResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.webgl.setSize(window.innerWidth, window.innerHeight);
  };

  private frame = () => {
    const entities = this.composeEntities();
    syncPlayerMeshes(
      entities,
      this.localPlayerId,
      this.meshes,
      this.playerGroup,
      this.factory,
    );
    this.updateCamera();
    this.webgl.render(this.scene, this.camera);
  };

  private composeEntities(): RenderableEntity[] {
    const tRender = this.now() - REMOTE_RENDER_DELAY_MS;
    const out: RenderableEntity[] = [];
    for (const player of this.world.players()) {
      if (player.id === this.localPlayerId) {
        // Local player: latest authoritative position, no interpolation lag.
        out.push({ id: player.id, x: player.x, y: player.y });
        continue;
      }
      // Remote: 100 ms-delayed interpolated position. Falls back to the
      // current world position if no buffered samples exist yet (only
      // possible immediately after spawn, before the first push lands).
      const interp = this.buffer.sample(player.id, tRender);
      const pos = interp ?? { x: player.x, y: player.y };
      out.push({ id: player.id, x: pos.x, y: pos.y });
    }
    return out;
  }

  private updateCamera() {
    const target =
      this.localPlayerId !== null
        ? this.world.getPlayer(this.localPlayerId)
        : undefined;
    const focus = target
      ? tileToScene(target.x, target.y)
      : new THREE.Vector3(0, 0, 0);
    this.camera.position.set(focus.x, CAMERA_HEIGHT, focus.z);
    this.camera.lookAt(focus);
  }
}
