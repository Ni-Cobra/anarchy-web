/**
 * Per-tick entity visualization (task 010-entities, client half 020).
 *
 * The server is tile-bound: an `Entity` occupies an integer tile and
 * teleports between tiles on the ticks it steps. The client renders
 * entities at *continuous* world positions, animating from the previous
 * tile to the new tile over [`ENTITY_STEP_TRANSITION_MS`] each time the
 * server-mirrored tile changes. Multiple entities on the same tile sit
 * next to each other via a deterministic per-rank stacking offset (so
 * two clients viewing the same chunk see the same arrangement).
 *
 * Today the only kind is the spider, rendered as a small flat-black
 * square. Adding a kind is one new factory + one arm in `meshForKind`.
 *
 * Reads the game-state entity mirror through `Terrain.iter` each frame —
 * the wire bridge populates `Chunk.entities` and the implicit chunk-unload
 * rule retires entities for free.
 */

import * as THREE from "three";

import { ENTITY_STEP_TRANSITION_MS } from "../config.js";
import {
  type Entity,
  type EntityId,
  EntityKind,
  type Terrain,
} from "../game/index.js";
import { tileCenterToScene } from "./terrain.js";

// Spider mesh dimensions. The brief calls for a flat black square ~0.6 ×
// 0.6 of a tile — a thin `BoxGeometry` instead of `PlaneGeometry` so the
// shape reads from any camera angle. Sits a hair above the ground so it
// doesn't z-fight with the terrain slab.
const SPIDER_SIDE = 0.6;
const SPIDER_HEIGHT = 0.05;
const SPIDER_Y = SPIDER_HEIGHT / 2 + 0.015;
const SPIDER_COLOR = 0x000000;

/**
 * Radius (in tile-units) of the per-rank stacking offset circle. Each
 * entity on a tile is shifted onto a circle of this radius so a stack of
 * N visually fans out rather than overlapping. Tuned to keep all
 * entities visually inside the tile while staying distinct at N = 2..5.
 */
export const ENTITY_STACK_OFFSET_RADIUS = 0.18;

/**
 * Smoothstep curve `t² (3 - 2t)`, clamped to [0, 1]. Reads better than
 * linear at sub-second durations because the ease-in/out softens both
 * the start and the settle.
 */
export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Interpolated world position along the smoothstep curve from
 * `(lastX, lastY)` to `(targetX, targetY)` at normalized progress `t`
 * (clamped). Exported as a pure helper so the per-frame layer and unit
 * tests share the same math.
 */
export function entityLerpPosition(
  lastX: number,
  lastY: number,
  targetX: number,
  targetY: number,
  t: number,
): { x: number; y: number } {
  const e = smoothstep(t);
  return {
    x: lastX + (targetX - lastX) * e,
    y: lastY + (targetY - lastY) * e,
  };
}

/**
 * Deterministic per-rank offset for an entity sitting on a tile shared
 * with `count - 1` others. Sorted by `EntityId` upstream so all observers
 * agree on the rank; the offset lays the stack out on a circle of
 * [`ENTITY_STACK_OFFSET_RADIUS`] around the tile centre.
 *
 * `(dx, dy)` are in tile-local world coords matching the server's
 * `(+x, +y)` axes. `count === 1` returns the origin so the lone-spider
 * case sits dead-centre on its tile.
 */
export function stackingOffset(
  rank: number,
  count: number,
): { dx: number; dy: number } {
  if (count <= 1) return { dx: 0, dy: 0 };
  const angle = (rank / count) * Math.PI * 2;
  return {
    dx: ENTITY_STACK_OFFSET_RADIUS * Math.cos(angle),
    dy: ENTITY_STACK_OFFSET_RADIUS * Math.sin(angle),
  };
}

interface EntityRenderState {
  readonly mesh: THREE.Mesh;
  readonly kind: EntityKind;
  // Last tile observed from the game-state mirror. A change between
  // frames triggers a fresh transition starting from wherever the mesh
  // currently is.
  knownTileX: number;
  knownTileY: number;
  // Lerp source. Captured at transition start (or seeded equal to the
  // initial target on first appearance) so the per-frame interpolation
  // is `lerp(from, target, t(elapsed))` rather than chasing its own tail.
  fromSceneX: number;
  fromSceneZ: number;
  // Scene-space (x, z) the mesh was last drawn at. Becomes the next
  // `from*` when a re-snapshot mid-transition fires — that's the "no
  // queueing, restart from wherever we are" rule from the brief.
  renderedSceneX: number;
  renderedSceneZ: number;
  transitionStartMs: number;
}

/**
 * Per-frame entity render layer. Owns a `THREE.Group` carrying one mesh
 * per known entity. Construction-only — feed it a parent scene; per-tick
 * mutations flow through [`update`].
 */
export class EntityLayer {
  readonly group: THREE.Group;
  private readonly states = new Map<EntityId, EntityRenderState>();
  // Pre-built shared geometry + material so a 50-spider chunk doesn't
  // allocate 50 GPU buffers. `dispose()` walks one set at teardown.
  private readonly spiderGeometry: THREE.BufferGeometry;
  private readonly spiderMaterial: THREE.Material;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = "entities";
    this.spiderGeometry = new THREE.BoxGeometry(
      SPIDER_SIDE,
      SPIDER_HEIGHT,
      SPIDER_SIDE,
    );
    this.spiderMaterial = new THREE.MeshBasicMaterial({ color: SPIDER_COLOR });
  }

  /** Per-frame mutation: reconcile mesh pool with `terrain`'s entities. */
  update(terrain: Terrain | null, nowMs: number): void {
    const seen = new Set<EntityId>();
    if (terrain !== null) {
      const stacksByTile = collectStacks(terrain);
      for (const stack of stacksByTile.values()) {
        // `stack.entities` is already sorted ascending by `EntityId`
        // (see `collectStacks`) so every observer of this chunk paints
        // the same on-tile arrangement.
        for (let rank = 0; rank < stack.entities.length; rank++) {
          const entity = stack.entities[rank];
          seen.add(entity.id);
          this.syncOne(entity, rank, stack.entities.length, nowMs);
        }
      }
    }
    // Drop meshes whose entities are gone (chunk unloaded, entity
    // removed). The Three.js group + mesh tear down here, not in
    // `dispose()`, so per-frame churn doesn't leak.
    for (const [id, state] of this.states) {
      if (seen.has(id)) continue;
      this.group.remove(state.mesh);
      this.states.delete(id);
    }
  }

  dispose(): void {
    for (const state of this.states.values()) this.group.remove(state.mesh);
    this.states.clear();
    this.spiderGeometry.dispose();
    this.spiderMaterial.dispose();
  }

  /** Number of meshes currently rendered. Test handle. */
  size(): number {
    return this.states.size;
  }

  /**
   * Read the scene-space `(x, z)` the entity is currently rendered at.
   * Exposed for e2e specs that pin "the spider exists" and "the spider
   * moved" without poking at Three.js internals. Returns `null` when no
   * mesh exists for the given id.
   */
  getRenderedScenePosition(
    id: EntityId,
  ): { x: number; z: number } | null {
    const state = this.states.get(id);
    if (!state) return null;
    return { x: state.renderedSceneX, z: state.renderedSceneZ };
  }

  /** Iterate `(id, sceneX, sceneZ)` for every entity currently rendered. */
  *iterRendered(): IterableIterator<{
    id: EntityId;
    x: number;
    z: number;
  }> {
    for (const [id, state] of this.states) {
      yield { id, x: state.renderedSceneX, z: state.renderedSceneZ };
    }
  }

  private syncOne(
    entity: Entity,
    rank: number,
    stackSize: number,
    nowMs: number,
  ): void {
    const target = targetSceneFor(entity, rank, stackSize);
    let state = this.states.get(entity.id);
    if (!state) {
      const mesh = this.buildMesh(entity.kind);
      mesh.position.set(target.x, SPIDER_Y, target.z);
      this.group.add(mesh);
      state = {
        mesh,
        kind: entity.kind,
        knownTileX: entity.tileX,
        knownTileY: entity.tileY,
        fromSceneX: target.x,
        fromSceneZ: target.z,
        renderedSceneX: target.x,
        renderedSceneZ: target.z,
        // -Infinity guarantees the next frame sees `t >= 1` and stays
        // settled at `target` — the brief calls for first-appearance
        // pop-in, no incoming-from-elsewhere animation.
        transitionStartMs: Number.NEGATIVE_INFINITY,
      };
      this.states.set(entity.id, state);
      return;
    }
    // Tile change since last frame? Capture the *current* rendered
    // position as the new lerp source and bump the transition clock —
    // the "no queueing, restart from wherever we are" rule.
    if (state.knownTileX !== entity.tileX || state.knownTileY !== entity.tileY) {
      state.knownTileX = entity.tileX;
      state.knownTileY = entity.tileY;
      state.fromSceneX = state.renderedSceneX;
      state.fromSceneZ = state.renderedSceneZ;
      state.transitionStartMs = nowMs;
    }
    const elapsed = nowMs - state.transitionStartMs;
    const tRaw = elapsed / ENTITY_STEP_TRANSITION_MS;
    const t = tRaw <= 0 ? 0 : tRaw >= 1 ? 1 : tRaw;
    const lerped = entityLerpPosition(
      state.fromSceneX,
      state.fromSceneZ,
      target.x,
      target.z,
      t,
    );
    state.mesh.position.set(lerped.x, SPIDER_Y, lerped.y);
    state.renderedSceneX = lerped.x;
    state.renderedSceneZ = lerped.y;
  }

  private buildMesh(kind: EntityKind): THREE.Mesh {
    switch (kind) {
      case EntityKind.Spider: {
        const mesh = new THREE.Mesh(this.spiderGeometry, this.spiderMaterial);
        mesh.name = "spider";
        return mesh;
      }
    }
  }
}

/**
 * Index entities by `(tileX, tileY)` and sort each stack ascending by id.
 * Determinism matters: every observer must compute the same rank → offset
 * pairing for a given (tile, entity set).
 */
function collectStacks(
  terrain: Terrain,
): Map<string, { tileX: number; tileY: number; entities: Entity[] }> {
  const stacks = new Map<
    string,
    { tileX: number; tileY: number; entities: Entity[] }
  >();
  for (const [, chunk] of terrain.iter()) {
    for (const entity of chunk.entities.values()) {
      const key = `${entity.tileX},${entity.tileY}`;
      let stack = stacks.get(key);
      if (!stack) {
        stack = { tileX: entity.tileX, tileY: entity.tileY, entities: [] };
        stacks.set(key, stack);
      }
      stack.entities.push(entity);
    }
  }
  for (const stack of stacks.values()) {
    stack.entities.sort((a, b) => a.id - b.id);
  }
  return stacks;
}

/**
 * Resolve `(tileX, tileY) + per-rank offset` to a scene-space `(x, z)`
 * via the same world↔scene mapping as `tileCenterToScene`. The entity's
 * world tile is global (not local-to-chunk) so the chunk coord is `(0, 0)`
 * with the world tile fed as the local offset.
 */
function targetSceneFor(
  entity: Entity,
  rank: number,
  stackSize: number,
): { x: number; z: number } {
  const offset = stackingOffset(rank, stackSize);
  // `tileCenterToScene` expects `(cx, cy, lx, ly)` and bakes in the
  // `+0.5` tile-centre shift. Feeding the world tile via the local
  // pair and `cx=cy=0` works as long as we don't rely on chunk-local
  // bounds elsewhere here.
  const sceneCentre = tileCenterToScene(0, 0, entity.tileX, entity.tileY);
  // Server `+y` → scene `-z` (see `tileCenterToScene`); apply the same
  // sign flip to the offset.
  return { x: sceneCentre.x + offset.dx, z: sceneCentre.z - offset.dy };
}
