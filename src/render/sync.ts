import * as THREE from "three";

import type { Player, PlayerId, World } from "../game/index.js";

/**
 * Builds a fresh `THREE.Mesh` for a player. `isLocal` lets the factory pick a
 * distinct color so the local player can never be confused with a remote one.
 */
export interface PlayerMeshFactory {
  create(player: Player, isLocal: boolean): THREE.Mesh;
}

/**
 * Map server tile coords (`+x = east`, `+y = north`) into Three.js scene
 * coords. The y axis in Three.js is "up", so server's planar y becomes
 * scene's `-z` and the cube sits on top of the ground plane (`y = 0.5`).
 */
export function tileToScene(x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x, 0.5, -y);
}

/**
 * Reconcile `meshes` and `parent` with the players currently in `world`:
 *   - players new to the world get a mesh built by `factory` and added,
 *   - existing meshes get their position synced,
 *   - meshes whose player has left are removed and disposed.
 *
 * Pure of any rendering-loop / WebGL state — safe to unit-test against a
 * plain `THREE.Group`.
 */
export function syncPlayerMeshes(
  world: World,
  localPlayerId: PlayerId | null,
  meshes: Map<PlayerId, THREE.Mesh>,
  parent: THREE.Object3D,
  factory: PlayerMeshFactory,
): void {
  const seen = new Set<PlayerId>();
  for (const player of world.players()) {
    seen.add(player.id);
    let mesh = meshes.get(player.id);
    if (!mesh) {
      mesh = factory.create(player, player.id === localPlayerId);
      meshes.set(player.id, mesh);
      parent.add(mesh);
    }
    mesh.position.copy(tileToScene(player.x, player.y));
  }
  for (const id of [...meshes.keys()]) {
    if (seen.has(id)) continue;
    disposePlayerMesh(meshes.get(id)!, parent);
    meshes.delete(id);
  }
}

/**
 * Detach `mesh` from `parent` and free its GPU-side geometry + material.
 * Exported so callers that drop a mesh outside the per-frame sync pass
 * (e.g. the renderer reassigning the local-player role) free the same
 * resources the same way.
 */
export function disposePlayerMesh(mesh: THREE.Mesh, parent: THREE.Object3D): void {
  parent.remove(mesh);
  mesh.geometry.dispose();
  if (Array.isArray(mesh.material)) {
    for (const m of mesh.material) m.dispose();
  } else {
    mesh.material.dispose();
  }
}
