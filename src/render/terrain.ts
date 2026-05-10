import * as THREE from "three";

import {
  BlockType,
  CHUNK_SIZE,
  type Chunk,
  LAYER_SIZE,
  type Terrain,
  getBlock,
} from "../game/index.js";
import type { BlockTextureSet } from "./texture_loader.js";

// Fake-ambient-occlusion against `BlockType.Hidden` neighbours (task 290).
// Each side of a top-layer cell that borders a Hidden cell darkens the two
// top-face corners on that edge; THREE's vertex-color interpolation fades the
// darkening back to the block's normal albedo across the cell. Multiple
// adjacent Hidden sides multiply, so a corner pinched between two Hidden
// neighbours darkens twice. The mask is a 4-bit set; bit positions are
// scene-space because that's how the geometry vertices are addressed.
const AO_X_NEG = 1;
const AO_X_POS = 1 << 1;
const AO_Z_NEG = 1 << 2;
const AO_Z_POS = 1 << 3;
const AO_MASK_NONE = 0;
const AO_DARKEN = 0.3;

/**
 * Build a Three.js group for a `Terrain` snapshot. Each loaded chunk becomes
 * a sub-group; each ground tile is a thin colored slab and each non-Air top
 * block is a smaller upright box. Coordinates use the same world↔scene
 * mapping as `tileToScene` in `sync.ts` (`+y_world → -z_scene`).
 *
 * `textures` is the shared `BlockTextureSet` produced once at renderer
 * construction and passed through to every chunk-mesh build. When `null`
 * (legacy / test path), tiles fall back to flat-color materials so unit
 * tests can pin the geometry without spinning up a `TextureLoader`.
 *
 * Pure function — call it once and add the result to a scene; call
 * `disposeTerrainMesh` to free GPU resources when the group leaves the
 * scene. The renderer rebuilds wholesale on `TerrainSnapshot` and per-chunk
 * via `buildChunkMesh` on `ChunkLoaded` / `ChunkUnloaded`.
 */
export function buildTerrainMesh(
  terrain: Terrain,
  textures: BlockTextureSet | null = null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "terrain";
  for (const [coord, chunk] of terrain.iter()) {
    const [cx, cy] = coord;
    group.add(buildChunkMesh(cx, cy, chunk, textures, terrain));
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
 * Fallback flat color per block kind. Used when the renderer is built
 * without a `BlockTextureSet` (the unit-test path) or when a kind happens
 * to lack a texture entry. Magenta surfaces missing kinds loudly rather
 * than rendering as black.
 */
const FALLBACK_BLOCK_COLOR: Partial<Record<BlockType, number>> = {
  [BlockType.Grass]: 0x4a8c2a,
  [BlockType.Stone]: 0x808080,
  [BlockType.Wood]: 0x8b5a2b,
  [BlockType.Gold]: 0xf5c542,
  [BlockType.Tree]: 0x2d6a2d,
  [BlockType.Sticks]: 0xa9774a,
  // Hidden cells render as pitch black (task 290): the server never emits
  // the true kind for occluded cells (task 060) so an attacker can't
  // distinguish underlying ore from stone by sampling pixels — pitch black
  // makes that an obvious solid void rather than a coy grey placeholder.
  // Adjacent visible top blocks pick up a faked AO darkening towards Hidden
  // neighbours so the void reads as "things you could mine into" rather
  // than a flat sticker.
  [BlockType.Hidden]: 0x000000,
  [BlockType.FlowerRed]: 0xe03333,
  [BlockType.FlowerYellow]: 0xf6ce42,
  [BlockType.FlowerBlue]: 0x4a6ee0,
  [BlockType.FlowerWhite]: 0xf2f4f8,
  [BlockType.Bush]: 0x336a2a,
  [BlockType.Dirt]: 0x6b4729,
  [BlockType.Sand]: 0xe5ce96,
  [BlockType.Gravel]: 0x888276,
  [BlockType.StoneLight]: 0xa8aeb6,
  [BlockType.StoneDark]: 0x525255,
  [BlockType.Torch]: 0xf6761a,
};

const GROUND_THICKNESS = 0.02;
// Lift ground tiles slightly above the y=0 world plane so they don't z-fight
// with the renderer's flat ground rectangle. Half-thickness centers the slab
// such that its top sits at GROUND_Y + GROUND_THICKNESS/2 ≈ 0.02.
const GROUND_Y = GROUND_THICKNESS / 2 + 0.005;
// Top-layer blocks occupy the full unit-cell footprint — identical XZ extent
// to a ground tile — so a top block visually fills the cell. Only their
// vertical extent and layer differ from a ground tile.
const TOP_BOX_WIDTH = 1.0;
const TOP_BOX_HEIGHT = 1.0;
// Place the top-block box so its bottom rests on the ground tile (above
// the ground-slab top), centered at half-height above that surface.
const TOP_BOX_Y = GROUND_Y + GROUND_THICKNESS / 2 + TOP_BOX_HEIGHT / 2;

// Trees get a low-poly trunk + canopy. Authoritative collision still uses
// the full unit cell on the server (top-layer Tree blocks the cell exactly
// like any other top block); these dimensions are visual only.
const TREE_TRUNK_WIDTH = 0.3;
const TREE_TRUNK_HEIGHT = 0.55;
const TREE_TRUNK_COLOR = 0x6b4423;
const TREE_CANOPY_WIDTH = 0.95;
const TREE_CANOPY_HEIGHT = 0.7;
const TREE_CANOPY_COLOR = 0x2d6a2d;
const TREE_TRUNK_BOTTOM = GROUND_Y + GROUND_THICKNESS / 2;
const TREE_TRUNK_Y = TREE_TRUNK_BOTTOM + TREE_TRUNK_HEIGHT / 2;
// Canopy bottom sits a bit below the trunk top so the two visually merge.
const TREE_CANOPY_Y =
  TREE_TRUNK_BOTTOM + TREE_TRUNK_HEIGHT - TREE_CANOPY_HEIGHT * 0.25 + TREE_CANOPY_HEIGHT / 2;

// Sticks are a thin flat decal hugging the ground — no collision server-side,
// so the visual is intentionally low-profile so trees + standing geometry
// remain the dominant verticals in a felled grove. Slightly inset from the
// full cell so adjacent sticks read as separate piles, and lifted just
// above the ground slab so they don't z-fight with it.
const STICKS_WIDTH = 0.7;
const STICKS_THICKNESS = 0.06;
const STICKS_COLOR = 0xa9774a;
const STICKS_Y = GROUND_Y + GROUND_THICKNESS / 2 + STICKS_THICKNESS / 2;

// Decorative content (task 130). Flowers render as thin upright slabs so the
// player perceives a stem-with-petals rather than a wall — they're non-solid
// server-side and the visual carries that affordance. Bushes render as a
// wider, shorter mound. Both are rendered as plain boxes textured with the
// per-kind PNG so the painted detail (petals / leaves) does the heavy
// lifting; the box silhouette just sets the read.
const FLOWER_WIDTH = 0.5;
const FLOWER_HEIGHT = 0.7;
const FLOWER_BOTTOM = GROUND_Y + GROUND_THICKNESS / 2;
const FLOWER_Y = FLOWER_BOTTOM + FLOWER_HEIGHT / 2;
const BUSH_WIDTH = 0.85;
const BUSH_HEIGHT = 0.55;
const BUSH_BOTTOM = GROUND_Y + GROUND_THICKNESS / 2;
const BUSH_Y = BUSH_BOTTOM + BUSH_HEIGHT / 2;

// Torch (task 350): a small upright billboard so the painted sprite (haft +
// flame) reads against whatever is behind it. Non-solid server-side, like
// Sticks; only the texture's opaque pixels render thanks to `transparent:
// true` + an alpha-test threshold on the material.
const TORCH_WIDTH = 0.4;
const TORCH_HEIGHT = 0.85;
const TORCH_BOTTOM = GROUND_Y + GROUND_THICKNESS / 2;
const TORCH_Y = TORCH_BOTTOM + TORCH_HEIGHT / 2;

/**
 * Build a per-chunk sub-group named `chunk:cx,cy`. Exported so the renderer
 * can rebuild a single chunk on a `ChunkLoaded` event without throwing away
 * the rest of the terrain mesh.
 *
 * `textures` is the shared `BlockTextureSet` from the renderer; when
 * `null` the chunk falls back to flat-color materials (unit-test path).
 *
 * `terrain` is the surrounding world snapshot used to read top-layer
 * neighbours across chunk borders for the `Hidden`-adjacent AO pass (task
 * 290). When `null`, neighbour cells in adjacent chunks are treated as
 * "not Hidden" — the spec's "unloaded neighbour leaves that edge unshaded"
 * rule, also the unit-test path.
 */
export function buildChunkMesh(
  cx: number,
  cy: number,
  chunk: Chunk,
  textures: BlockTextureSet | null = null,
  terrain: Terrain | null = null,
): THREE.Group {
  // Per-chunk shared geometries + materials. Sharing keeps the per-build
  // allocation count proportional to "kinds present" rather than "tiles" —
  // and the dedupe-on-dispose set in `disposeTerrainMesh` handles cleanup.
  const groundGeom = new THREE.BoxGeometry(1, GROUND_THICKNESS, 1);
  const topGeom = new THREE.BoxGeometry(TOP_BOX_WIDTH, TOP_BOX_HEIGHT, TOP_BOX_WIDTH);
  const matCache = new Map<BlockType, THREE.Material>();
  const materialFor = (kind: BlockType): THREE.Material => {
    let m = matCache.get(kind);
    if (!m) {
      m = buildBlockMaterial(kind, textures);
      matCache.set(kind, m);
    }
    return m;
  };

  // AO-side caches (task 290). Sibling of the regular geom/mat caches:
  // `aoGeomFor` clones the top geometry and bakes vertex colors per
  // 4-bit Hidden-neighbour mask — at most 15 distinct non-zero masks —
  // and `aoMaterialFor` clones the per-kind material with `vertexColors`
  // turned on so the bake actually attenuates the texture/color. Blocks
  // with no Hidden neighbour (`mask == 0`) keep using the shared topGeom
  // + plain material, so a chunk with no Hidden cells pays nothing.
  const aoGeomCache = new Map<number, THREE.BoxGeometry>();
  const aoGeomFor = (mask: number): THREE.BoxGeometry => {
    let g = aoGeomCache.get(mask);
    if (!g) {
      g = buildAoTopGeometry(mask);
      aoGeomCache.set(mask, g);
    }
    return g;
  };
  const aoMatCache = new Map<BlockType, THREE.Material>();
  const aoMaterialFor = (kind: BlockType): THREE.Material => {
    let m = aoMatCache.get(kind);
    if (!m) {
      m = buildBlockMaterial(kind, textures, undefined, true);
      aoMatCache.set(kind, m);
    }
    return m;
  };

  // Tree-specific resources, allocated lazily so a chunk with no trees
  // doesn't pay for them. `disposeTerrainMesh`'s dedupe handles cleanup.
  let trunkGeom: THREE.BoxGeometry | null = null;
  let canopyGeom: THREE.BoxGeometry | null = null;
  let trunkMat: THREE.Material | null = null;
  let canopyMat: THREE.Material | null = null;

  // Sticks-specific resources, allocated lazily for the same reason.
  let sticksGeom: THREE.BoxGeometry | null = null;
  let sticksMat: THREE.Material | null = null;

  // Decorative content (task 130). Flowers and bushes share their geometry
  // across instances of the same kind in a chunk, so the per-build allocation
  // count stays small even on a flowery hilltop.
  let flowerGeom: THREE.BoxGeometry | null = null;
  let bushGeom: THREE.BoxGeometry | null = null;

  // Torch geometry (task 350). One thin upright box per torch in the chunk;
  // shares a single transparent material instance.
  let torchGeom: THREE.BoxGeometry | null = null;
  let torchMat: THREE.Material | null = null;

  const group = new THREE.Group();
  group.name = `chunk:${cx},${cy}`;

  for (let y = 0; y < LAYER_SIZE; y++) {
    for (let x = 0; x < LAYER_SIZE; x++) {
      const groundBlock = getBlock(chunk.ground, x, y);
      if (groundBlock.kind !== BlockType.Air) {
        const mesh = new THREE.Mesh(groundGeom, materialFor(groundBlock.kind));
        const scene = tileCenterToScene(cx, cy, x, y);
        mesh.position.set(scene.x, GROUND_Y, scene.z);
        // Ground tiles only receive — a flat slab casting a shadow on its
        // identical neighbours produces dark seams under the day-cycle sun.
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      const topBlock = getBlock(chunk.top, x, y);
      if (topBlock.kind === BlockType.Air) continue;
      const scene = tileCenterToScene(cx, cy, x, y);
      if (topBlock.kind === BlockType.Tree) {
        if (!trunkGeom)
          trunkGeom = new THREE.BoxGeometry(
            TREE_TRUNK_WIDTH,
            TREE_TRUNK_HEIGHT,
            TREE_TRUNK_WIDTH,
          );
        if (!canopyGeom)
          canopyGeom = new THREE.BoxGeometry(
            TREE_CANOPY_WIDTH,
            TREE_CANOPY_HEIGHT,
            TREE_CANOPY_WIDTH,
          );
        if (!trunkMat)
          trunkMat = buildBlockMaterial(BlockType.Wood, textures, TREE_TRUNK_COLOR);
        if (!canopyMat)
          canopyMat = buildBlockMaterial(BlockType.Tree, textures, TREE_CANOPY_COLOR);
        const trunk = new THREE.Mesh(trunkGeom, trunkMat);
        trunk.position.set(scene.x, TREE_TRUNK_Y, scene.z);
        trunk.castShadow = true;
        trunk.receiveShadow = true;
        group.add(trunk);
        const canopy = new THREE.Mesh(canopyGeom, canopyMat);
        canopy.position.set(scene.x, TREE_CANOPY_Y, scene.z);
        canopy.castShadow = true;
        canopy.receiveShadow = true;
        group.add(canopy);
      } else if (topBlock.kind === BlockType.Sticks) {
        if (!sticksGeom)
          sticksGeom = new THREE.BoxGeometry(STICKS_WIDTH, STICKS_THICKNESS, STICKS_WIDTH);
        if (!sticksMat)
          sticksMat = buildBlockMaterial(BlockType.Sticks, textures, STICKS_COLOR);
        const decal = new THREE.Mesh(sticksGeom, sticksMat);
        decal.position.set(scene.x, STICKS_Y, scene.z);
        decal.receiveShadow = true;
        group.add(decal);
      } else if (
        topBlock.kind === BlockType.FlowerRed ||
        topBlock.kind === BlockType.FlowerYellow ||
        topBlock.kind === BlockType.FlowerBlue ||
        topBlock.kind === BlockType.FlowerWhite
      ) {
        if (!flowerGeom)
          flowerGeom = new THREE.BoxGeometry(FLOWER_WIDTH, FLOWER_HEIGHT, FLOWER_WIDTH);
        const mesh = new THREE.Mesh(flowerGeom, materialFor(topBlock.kind));
        mesh.position.set(scene.x, FLOWER_Y, scene.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      } else if (topBlock.kind === BlockType.Bush) {
        if (!bushGeom)
          bushGeom = new THREE.BoxGeometry(BUSH_WIDTH, BUSH_HEIGHT, BUSH_WIDTH);
        const mesh = new THREE.Mesh(bushGeom, materialFor(BlockType.Bush));
        mesh.position.set(scene.x, BUSH_Y, scene.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      } else if (topBlock.kind === BlockType.Torch) {
        if (!torchGeom)
          torchGeom = new THREE.BoxGeometry(TORCH_WIDTH, TORCH_HEIGHT, TORCH_WIDTH);
        if (!torchMat) torchMat = buildTorchMaterial(textures);
        const mesh = new THREE.Mesh(torchGeom, torchMat);
        mesh.position.set(scene.x, TORCH_Y, scene.z);
        // Don't cast shadow — the torch is a thin box with a transparent
        // texture and the standard shadow pass would silhouette the full
        // box, painting an opaque rectangle on the ground that doesn't
        // match the painted flame.
        mesh.receiveShadow = true;
        group.add(mesh);
      } else {
        // Standard full-cell top block. Tree/Sticks/flowers/bushes branch
        // away above; we don't AO those because they aren't `is_full` on
        // the server, so a Hidden cell can never have one as a neighbour
        // (the cell would fail the all-four-full predicate). The branches
        // above therefore cannot border Hidden in practice.
        const mask = hiddenMaskAt(chunk, terrain, cx, cy, x, y);
        const mesh =
          mask === AO_MASK_NONE
            ? new THREE.Mesh(topGeom, materialFor(topBlock.kind))
            : new THREE.Mesh(aoGeomFor(mask), aoMaterialFor(topBlock.kind));
        mesh.position.set(scene.x, TOP_BOX_Y, scene.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
  }

  // If a chunk happened to be all-Air on both layers, drop the unused
  // shared geometries so they don't leak. Tree resources are only
  // allocated on demand, so they don't need a fallback path. AO geom +
  // material caches are only populated lazily, so empty chunks don't pay
  // for them either.
  if (group.children.length === 0) {
    groundGeom.dispose();
    topGeom.dispose();
  }
  return group;
}

/**
 * Build a transparent `MeshLambertMaterial` for the torch sprite. The torch
 * texture is RGBA — opaque flame + haft pixels surrounded by fully
 * transparent backdrop — so the renderer needs `transparent: true` for the
 * alpha to take. `alphaTest` cuts the near-zero pixels at depth-test time so
 * the box doesn't paint a translucent rectangle when viewed against another
 * transparent surface. When no texture set is supplied (unit-test path) the
 * material falls back to the warm flame color from `FALLBACK_BLOCK_COLOR`
 * so the test renderer still produces a visible mesh.
 */
function buildTorchMaterial(
  textures: BlockTextureSet | null,
): THREE.MeshLambertMaterial {
  const tex = textures?.get(BlockType.Torch) ?? null;
  if (tex) {
    return new THREE.MeshLambertMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.5,
    });
  }
  return new THREE.MeshLambertMaterial({
    color: FALLBACK_BLOCK_COLOR[BlockType.Torch] ?? 0xff00ff,
  });
}

/**
 * Scene-space positions of every Torch top-layer cell in `chunk` at
 * `(cx, cy)`. The torch-light subsystem (`torch_lights.ts`) consumes this on
 * `applyChunkLoaded` so each chunk's torches contribute to the per-frame
 * "32 nearest" pick around the local player.
 */
export function torchPositionsInChunk(
  cx: number,
  cy: number,
  chunk: Chunk,
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let y = 0; y < LAYER_SIZE; y++) {
    for (let x = 0; x < LAYER_SIZE; x++) {
      if (getBlock(chunk.top, x, y).kind !== BlockType.Torch) continue;
      const scene = tileCenterToScene(cx, cy, x, y);
      out.push({ x: scene.x, z: scene.z });
    }
  }
  return out;
}

/**
 * Build a `MeshLambertMaterial` for a given block kind. Prefers the loaded
 * texture from `textures` (with `NearestFilter` already configured by the
 * loader); falls back to the per-kind flat color when `textures` is
 * `null` (test path) or the kind is missing from the set. `colorOverride`
 * is for the tree-trunk / sticks special cases that want their historical
 * accent color in the no-texture fallback. `vertexColors` enables the
 * per-vertex tint multiply that the Hidden-AO geometry pass (task 290)
 * uses to darken edges near the void; off by default so the regular
 * shared materials stay untouched.
 */
function buildBlockMaterial(
  kind: BlockType,
  textures: BlockTextureSet | null,
  colorOverride?: number,
  vertexColors = false,
): THREE.MeshLambertMaterial {
  const tex = textures?.get(kind) ?? null;
  if (tex) return new THREE.MeshLambertMaterial({ map: tex, vertexColors });
  const color =
    colorOverride ?? FALLBACK_BLOCK_COLOR[kind] ?? 0xff00ff;
  return new THREE.MeshLambertMaterial({ color, vertexColors });
}

/**
 * Compute the 4-bit Hidden-neighbour mask for the top-layer cell at
 * `(lx, ly)` inside chunk `(cx, cy)`. Each set bit means "the top-layer
 * neighbour on that side is `BlockType.Hidden`". Cross-chunk neighbours
 * read from `terrain` if loaded; an absent neighbour chunk leaves that
 * side unset (per the task spec — unloaded ≠ Hidden).
 */
function hiddenMaskAt(
  chunk: Chunk,
  terrain: Terrain | null,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): number {
  let mask = AO_MASK_NONE;
  if (isHiddenTop(chunk, terrain, cx, cy, lx - 1, ly)) mask |= AO_X_NEG;
  if (isHiddenTop(chunk, terrain, cx, cy, lx + 1, ly)) mask |= AO_X_POS;
  // World +y → scene -z, so the world-+y neighbour is the scene -z side.
  if (isHiddenTop(chunk, terrain, cx, cy, lx, ly + 1)) mask |= AO_Z_NEG;
  if (isHiddenTop(chunk, terrain, cx, cy, lx, ly - 1)) mask |= AO_Z_POS;
  return mask;
}

/**
 * Read the top-layer kind at `(cx, cy, lx, ly)` (lx/ly may be off-chunk;
 * we step into the right chunk) and return whether it is `Hidden`.
 * Returns `false` when the resolved chunk isn't loaded — mirrors the
 * server's `is_hidden_top` "unloaded neighbour leaves the cell visible"
 * rule and the task spec's "unloaded neighbour is not a Hidden neighbour".
 */
function isHiddenTop(
  selfChunk: Chunk,
  terrain: Terrain | null,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): boolean {
  let tcx = cx;
  let tcy = cy;
  let tlx = lx;
  let tly = ly;
  if (tlx < 0) {
    tcx -= 1;
    tlx += LAYER_SIZE;
  } else if (tlx >= LAYER_SIZE) {
    tcx += 1;
    tlx -= LAYER_SIZE;
  }
  if (tly < 0) {
    tcy -= 1;
    tly += LAYER_SIZE;
  } else if (tly >= LAYER_SIZE) {
    tcy += 1;
    tly -= LAYER_SIZE;
  }
  const targetChunk =
    tcx === cx && tcy === cy ? selfChunk : terrain?.get(tcx, tcy) ?? null;
  if (!targetChunk) return false;
  return getBlock(targetChunk.top, tlx, tly).kind === BlockType.Hidden;
}

/**
 * Clone the standard top BoxGeometry and bake per-vertex colors on the
 * top face per the AO mask. Each vertex on the top face (positive-Y
 * normal) starts at white `(1, 1, 1)`; for every adjacent Hidden side
 * touching that vertex the color is multiplied by `AO_DARKEN`. THREE
 * interpolates the colors across the face, so the dark edge fades back
 * to the block's normal albedo across the cell. Side / bottom faces
 * keep white vertex colors so the texture renders unchanged from those
 * angles (irrelevant for the top-down camera today, but cheap insurance).
 */
function buildAoTopGeometry(mask: number): THREE.BoxGeometry {
  const geom = new THREE.BoxGeometry(TOP_BOX_WIDTH, TOP_BOX_HEIGHT, TOP_BOX_WIDTH);
  const positions = geom.getAttribute("position") as THREE.BufferAttribute;
  // Each BoxGeometry face owns its own vertices, so the corner shared
  // between e.g. the +y, +x and +z faces appears 3 times in the buffer
  // — once per face, each with that face's normal. Filter on normal so
  // only the +y-face copy gets the AO bake; side-face vertices with the
  // same world y must stay white or the bake leaks onto the sides.
  const normals = geom.getAttribute("normal") as THREE.BufferAttribute;
  const count = positions.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let c = 1;
    if (normals.getY(i) > 0.5) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      if (x < 0 && (mask & AO_X_NEG) !== 0) c *= AO_DARKEN;
      if (x > 0 && (mask & AO_X_POS) !== 0) c *= AO_DARKEN;
      if (z < 0 && (mask & AO_Z_NEG) !== 0) c *= AO_DARKEN;
      if (z > 0 && (mask & AO_Z_POS) !== 0) c *= AO_DARKEN;
    }
    colors[i * 3 + 0] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geom;
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

