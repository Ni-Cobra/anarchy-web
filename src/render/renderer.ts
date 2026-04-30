import * as THREE from "three";

import type { Player, PlayerId, World } from "../game/index.js";
import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
} from "./sync.js";

const LOCAL_COLOR = 0xff3030;
const REMOTE_COLOR = 0x1e90ff;
const CUBE_SIZE = 1;
const CAMERA_HEIGHT = 14;

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
 * Owns the Three.js scene + render loop. Each frame it pulls the latest
 * server-authoritative player set out of `world` and reconciles meshes,
 * then keeps the camera anchored over the local player.
 *
 * The renderer is networking-agnostic: a future wire layer feeds `World`
 * via `applySnapshot` / `removePlayer` and tells us who we are with
 * `setLocalPlayerId`. Nothing here knows about WebSockets or protobuf.
 */
export class Renderer {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly webgl: THREE.WebGLRenderer;
  private readonly playerGroup: THREE.Group;
  private readonly meshes = new Map<PlayerId, THREE.Mesh>();
  private readonly factory: PlayerMeshFactory;
  private localPlayerId: PlayerId | null = null;

  constructor(
    private readonly world: World,
    container: HTMLElement = document.body,
    factory: PlayerMeshFactory = defaultFactory,
  ) {
    this.factory = factory;

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
    syncPlayerMeshes(
      this.world,
      this.localPlayerId,
      this.meshes,
      this.playerGroup,
      this.factory,
    );
    this.updateCamera();
    this.webgl.render(this.scene, this.camera);
  };

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
