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
 * Body yaw turn rate, radians per second. ~π / 0.15 rad/s gives a half-
 * revolution in 150 ms — fast enough to feel responsive, slow enough that
 * a single tick of facing change doesn't read as a snap. Server-side
 * facing math is unchanged (still discrete `Direction8`); this only
 * smooths the *render-side* angle interpolating toward that target.
 */
export const TURN_RATE_RAD_PER_SEC = Math.PI / 0.15;

/**
 * One entity to draw this frame. The renderer composes these from authoritative
 * world state for the local player and from the interpolation buffer for
 * remote players, but `syncPlayerMeshes` doesn't care which path produced
 * each entry — it just reconciles meshes against the iterable.
 *
 * `username` and `colorIndex` ride along on the entity so the mesh factory
 * can paint the body color and the name billboard at create time. They
 * never change for an admitted player (lobby identity is immutable
 * server-side), so reading them once per mesh is fine — the per-frame
 * sync only updates position + facing.
 */
export interface RenderableEntity {
  readonly id: PlayerId;
  readonly x: number;
  readonly y: number;
  readonly facing: Direction8;
  readonly username: string;
  readonly colorIndex: number;
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
 * Step `current` toward `target` by at most `maxStepRad` along the shortest
 * angular path. Both inputs are in radians; the result is wrapped into
 * `(-π, π]` so callers can keep accumulating without unbounded growth.
 *
 * Used by the per-frame sync pass to smoothly rotate a player body toward
 * its target yaw instead of snapping. The "shortest path" handling matters
 * when facing wraps across the ±π discontinuity (e.g. SW → SE crossing
 * south): a naive lerp would spin the body the long way around.
 */
export function lerpYawTowards(
  current: number,
  target: number,
  maxStepRad: number,
): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  let next: number;
  if (Math.abs(delta) <= maxStepRad) {
    next = target;
  } else {
    next = current + Math.sign(delta) * maxStepRad;
  }
  while (next > Math.PI) next -= 2 * Math.PI;
  while (next <= -Math.PI) next += 2 * Math.PI;
  return next;
}

/**
 * Reconcile `meshes` and `parent` with `entities`:
 *   - new ids get a mesh built by `factory`, added, and snapped to their
 *     initial yaw (no smooth-in for first appearance),
 *   - existing meshes get their position synced and their yaw lerped
 *     toward `facingToYaw(entity.facing)` at `TURN_RATE_RAD_PER_SEC`,
 *   - meshes whose id is no longer in `entities` are removed and disposed.
 *
 * `dtMs` is the time elapsed since the last sync call. Pass `Infinity`
 * (the default) to disable smoothing — useful for tests and for the very
 * first frame, where lerping toward a target with an unknown previous yaw
 * isn't meaningful. The renderer plumbs real per-frame deltas in.
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
  dtMs: number = Infinity,
): void {
  const maxStep = (TURN_RATE_RAD_PER_SEC * dtMs) / 1000;
  const seen = new Set<PlayerId>();
  for (const entity of entities) {
    seen.add(entity.id);
    let mesh = meshes.get(entity.id);
    const target = facingToYaw(entity.facing);
    if (!mesh) {
      mesh = factory.create(entity, entity.id === localPlayerId);
      meshes.set(entity.id, mesh);
      parent.add(mesh);
      mesh.rotation.y = target;
    } else {
      mesh.rotation.y = lerpYawTowards(mesh.rotation.y, target, maxStep);
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
 * Detach `mesh` from `parent` and free its GPU-side geometry + material,
 * including any child meshes parented to it. Materials carrying a `.map`
 * texture (e.g. the painted-eye body texture) get the texture disposed
 * alongside the material so per-player CanvasTextures don't accumulate
 * across reconnects.
 *
 * Exported so callers that drop a mesh outside the per-frame sync pass
 * (e.g. the renderer reassigning the local-player role) free the same
 * resources the same way.
 */
export function disposePlayerMesh(mesh: THREE.Mesh, parent: THREE.Object3D): void {
  parent.remove(mesh);
  const seenGeoms = new Set<THREE.BufferGeometry>();
  const seenMats = new Set<THREE.Material>();
  const seenTextures = new Set<THREE.Texture>();
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
      const map = (m as THREE.MeshLambertMaterial).map;
      if (map && !seenTextures.has(map)) {
        seenTextures.add(map);
        map.dispose();
      }
      m.dispose();
    }
  });
}
