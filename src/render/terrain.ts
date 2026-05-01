import * as THREE from "three";

import {
  BlockType,
  CHUNK_SIZE,
  type Chunk,
  LAYER_SIZE,
  type Terrain,
  getBlock,
} from "../game/index.js";

/**
 * Build a Three.js group for a `Terrain` snapshot. Each loaded chunk becomes
 * a sub-group; each ground tile is a thin colored slab and each non-Air top
 * block is a smaller upright box. Coordinates use the same world↔scene
 * mapping as `tileToScene` in `sync.ts` (`+y_world → -z_scene`).
 *
 * Pure function — call it once and add the result to a scene; call
 * `disposeTerrainMesh` to free GPU resources when the group leaves the
 * scene. The renderer rebuilds wholesale on `TerrainSnapshot` and per-chunk
 * via `buildChunkMesh` on `ChunkLoaded` / `ChunkUnloaded`.
 */
export function buildTerrainMesh(terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "terrain";
  for (const [coord, chunk] of terrain.iter()) {
    const [cx, cy] = coord;
    group.add(buildChunkMesh(cx, cy, chunk));
  }
  return group;
}

/**
 * Detach `group` from `parent` (if any) and free every unique geometry +
 * material reachable from it. Mirrors the dedupe pattern in
 * `disposePlayerMesh` so resources shared between sibling tiles fire their
 * `dispose` exactly once.
 */
export function disposeTerrainMesh(
  group: THREE.Object3D,
  parent?: THREE.Object3D,
): void {
  if (parent) parent.remove(group);
  const seenGeoms = new Set<THREE.BufferGeometry>();
  const seenMats = new Set<THREE.Material>();
  group.traverse((obj) => {
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

// ---- visual constants (kept here, not in config.ts — they're renderer-
// internal visual choices, not operator-tunable knobs) ----

/**
 * Color for each block kind. Wood is the only kind that appears on the top
 * layer in the placeholder worldgen; the table covers the others so a future
 * worldgen that puts e.g. Stone on top still has a sensible color.
 */
const BLOCK_COLOR: Record<BlockType, number> = {
  [BlockType.Air]: 0x000000,
  [BlockType.Grass]: 0x4a8c2a,
  [BlockType.Stone]: 0x808080,
  [BlockType.Wood]: 0x8b5a2b,
};

const GROUND_THICKNESS = 0.02;
// Lift ground tiles slightly above the y=0 world plane so they don't z-fight
// with the renderer's flat ground rectangle. Half-thickness centers the slab
// such that its top sits at GROUND_Y + GROUND_THICKNESS/2 ≈ 0.02.
const GROUND_Y = GROUND_THICKNESS / 2 + 0.005;
const TOP_BOX_WIDTH = 0.7;
const TOP_BOX_HEIGHT = 1.0;
// Place the top-block box so its bottom rests on the ground tile (above
// the ground-slab top), centered at half-height above that surface.
const TOP_BOX_Y = GROUND_Y + GROUND_THICKNESS / 2 + TOP_BOX_HEIGHT / 2;

/**
 * Build a per-chunk sub-group named `chunk:cx,cy`. Exported so the renderer
 * can rebuild a single chunk on a `ChunkLoaded` event without throwing away
 * the rest of the terrain mesh.
 */
export function buildChunkMesh(cx: number, cy: number, chunk: Chunk): THREE.Group {
  // Per-chunk shared geometries + materials. One shape per layer role; one
  // material per BlockType encountered. Sharing keeps the per-build
  // allocation count proportional to "kinds present" rather than "tiles" —
  // and the dedupe-on-dispose set in `disposeTerrainMesh` handles cleanup.
  const groundGeom = new THREE.BoxGeometry(1, GROUND_THICKNESS, 1);
  const topGeom = new THREE.BoxGeometry(TOP_BOX_WIDTH, TOP_BOX_HEIGHT, TOP_BOX_WIDTH);
  const matCache = new Map<BlockType, THREE.Material>();
  const materialFor = (kind: BlockType): THREE.Material => {
    let m = matCache.get(kind);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: BLOCK_COLOR[kind] });
      matCache.set(kind, m);
    }
    return m;
  };

  const group = new THREE.Group();
  group.name = `chunk:${cx},${cy}`;

  for (let y = 0; y < LAYER_SIZE; y++) {
    for (let x = 0; x < LAYER_SIZE; x++) {
      const groundBlock = getBlock(chunk.ground, x, y);
      if (groundBlock.kind !== BlockType.Air) {
        const mesh = new THREE.Mesh(groundGeom, materialFor(groundBlock.kind));
        const scene = tileCenterToScene(cx, cy, x, y);
        mesh.position.set(scene.x, GROUND_Y, scene.z);
        group.add(mesh);
      }
      const topBlock = getBlock(chunk.top, x, y);
      if (topBlock.kind !== BlockType.Air) {
        const mesh = new THREE.Mesh(topGeom, materialFor(topBlock.kind));
        const scene = tileCenterToScene(cx, cy, x, y);
        mesh.position.set(scene.x, TOP_BOX_Y, scene.z);
        group.add(mesh);
      }
    }
  }

  // If a chunk happened to be all-Air on both layers, drop the unused
  // geometries so they don't leak. The material cache is empty in that case.
  if (group.children.length === 0) {
    groundGeom.dispose();
    topGeom.dispose();
  }
  return group;
}

/**
 * Map a chunk-local tile `(x, y)` inside chunk `(cx, cy)` to the scene-space
 * center of that tile. World coords are `(cx*CHUNK_SIZE + x + 0.5,
 * cy*CHUNK_SIZE + y + 0.5)` — the `+0.5` centers within the unit square —
 * and the world↔scene mapping `(+x_world, +y_world) → (+x_scene, -z_scene)`
 * mirrors `tileToScene` in `sync.ts`.
 *
 * Exported so tests can pin the math without wading through Three.js
 * scene state.
 */
export function tileCenterToScene(
  cx: number,
  cy: number,
  x: number,
  y: number,
): { x: number; z: number } {
  const wx = cx * CHUNK_SIZE + x + 0.5;
  const wy = cy * CHUNK_SIZE + y + 0.5;
  return { x: wx, z: -wy };
}

