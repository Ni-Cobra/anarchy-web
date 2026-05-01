import * as THREE from "three";

import { Direction8, type PlayerId } from "../game/index.js";

/**
 * Builds a fresh `THREE.Mesh` for a player. `isLocal` lets the factory pick a
 * distinct color so the local player can never be confused with a remote one.
 * The factory only sees the renderable shape (`id` + position) — frame-by-
 * frame state like facing is applied by the per-frame sync pass, not at
 * mesh creation.
 */
export interface PlayerMeshFactory {
  create(entity: RenderableEntity, isLocal: boolean): THREE.Mesh;
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
  readonly facing: Direction8;
}

/**
 * Map server world coords (`+x = east`, `+y = north`) into Three.js scene
 * coords. The y axis in Three.js is "up", so server's planar y becomes
 * scene's `-z` and the player mesh sits on top of the ground plane
 * (`y = 0.5`). Inputs are continuous floats — interpolated remote positions
 * and predicted local positions both flow through here.
 */
export function tileToScene(x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x, 0.5, -y);
}

/**
 * Yaw (rotation around scene Y, in radians) that orients a mesh whose local
 * "front" points along +X (east) so it instead points in `facing`'s direction
 * once projected into the world XZ plane. Composed with the server↔scene
 * mapping `(+x, +y) → (+x, -z)` so server N ends up at scene -Z, etc.
 *
 * Pure helper — doesn't depend on `THREE`. Lives here so `syncPlayerMeshes`
 * and any future orientation-aware code share one source of truth.
 */
export function facingToYaw(facing: Direction8): number {
  switch (facing) {
    case Direction8.E:
      return 0;
    case Direction8.NE:
      return Math.PI / 4;
    case Direction8.N:
      return Math.PI / 2;
    case Direction8.NW:
      return (3 * Math.PI) / 4;
    case Direction8.W:
      return Math.PI;
    case Direction8.SW:
      return -(3 * Math.PI) / 4;
    case Direction8.S:
      return -Math.PI / 2;
    case Direction8.SE:
      return -Math.PI / 4;
  }
}

/**
 * Reconcile `meshes` and `parent` with `entities`:
 *   - new ids get a mesh built by `factory` and added,
 *   - existing meshes get their position + facing yaw synced,
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
      mesh = factory.create(entity, entity.id === localPlayerId);
      meshes.set(entity.id, mesh);
      parent.add(mesh);
    }
    mesh.position.copy(tileToScene(entity.x, entity.y));
    mesh.rotation.y = facingToYaw(entity.facing);
  }
  for (const id of [...meshes.keys()]) {
    if (seen.has(id)) continue;
    disposePlayerMesh(meshes.get(id)!, parent);
    meshes.delete(id);
  }
}

/**
 * Detach `mesh` from `parent` and free its GPU-side geometry + material,
 * including any child meshes parented to it (e.g. the eyes attached to the
 * sphere body). Exported so callers that drop a mesh outside the per-frame
 * sync pass (e.g. the renderer reassigning the local-player role) free the
 * same resources the same way.
 */
export function disposePlayerMesh(mesh: THREE.Mesh, parent: THREE.Object3D): void {
  parent.remove(mesh);
  const seenGeoms = new Set<THREE.BufferGeometry>();
  const seenMats = new Set<THREE.Material>();
  mesh.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!seenGeoms.has(obj.geometry)) {
      seenGeoms.add(obj.geometry);
      obj.geometry.dispose();
    }
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (seenMats.has(m)) continue;
      seenMats.add(m);
      m.dispose();
    }
  });
}
