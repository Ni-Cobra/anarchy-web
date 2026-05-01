import * as THREE from "three";

import type { Player, PlayerId } from "../game/index.js";

/**
 * Builds a fresh `THREE.Mesh` for a player. `isLocal` lets the factory pick a
 * distinct color so the local player can never be confused with a remote one.
 */
export interface PlayerMeshFactory {
  create(player: Player, isLocal: boolean): THREE.Mesh;
}

/**
 * One entity to draw this frame. The renderer composes these from authoritative
 * world state for the local player and from the interpolation buffer for
 * remote players, but `syncPlayerMeshes` doesn't care which path produced
 * each entry — it just reconciles meshes against the iterable.
 */
export interface RenderableEntity {
  readonly id: PlayerId;
  readonly x: number;
  readonly y: number;
}

/**
 * Map server world coords (`+x = east`, `+y = north`) into Three.js scene
 * coords. The y axis in Three.js is "up", so server's planar y becomes
 * scene's `-z` and the cube sits on top of the ground plane (`y = 0.5`).
 * Inputs are continuous floats — interpolated remote positions and (post
 * intent migration) sub-tile local positions both flow through here.
 */
export function tileToScene(x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x, 0.5, -y);
}

/**
 * Reconcile `meshes` and `parent` with `entities`:
 *   - new ids get a mesh built by `factory` and added,
 *   - existing meshes get their position synced,
 *   - meshes whose id is no longer in `entities` are removed and disposed.
 *
 * Pure of any rendering-loop / WebGL state — safe to unit-test against a
 * plain `THREE.Group`.
 */
export function syncPlayerMeshes(
  entities: Iterable<RenderableEntity>,
  localPlayerId: PlayerId | null,
  meshes: Map<PlayerId, THREE.Mesh>,
  parent: THREE.Object3D,
  factory: PlayerMeshFactory,
): void {
  const seen = new Set<PlayerId>();
  for (const entity of entities) {
    seen.add(entity.id);
    let mesh = meshes.get(entity.id);
    if (!mesh) {
      mesh = factory.create(
        { id: entity.id, x: entity.x, y: entity.y },
        entity.id === localPlayerId,
      );
      meshes.set(entity.id, mesh);
      parent.add(mesh);
    }
    mesh.position.copy(tileToScene(entity.x, entity.y));
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
