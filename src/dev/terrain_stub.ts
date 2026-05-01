/**
 * Dev-only entry that renders a hand-built `Terrain` without connecting to
 * the server. Triggered by `?stub-terrain=1` on the page URL. Useful for
 * eyeballing the terrain renderer in isolation while the
 * "Wire terrain over the network" task is pending.
 *
 * This is the only module besides `main.ts` allowed to touch
 * `window`/`document` directly — it owns the dev page's DOM root the same
 * way `main.ts` owns the production page's.
 */

import { LocalPredictor, SnapshotBuffer, World } from "../game/index.js";
import {
  BlockType,
  CHUNK_SIZE,
  Terrain,
  emptyChunk,
  setBlock,
  type Chunk,
} from "../game/index.js";
import { Renderer } from "../render/index.js";

/**
 * Coords of the four default chunks that meet at world origin (mirrors
 * `World::DEFAULT_CHUNK_COORDS` on the server).
 */
const DEFAULT_CHUNK_COORDS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [0, -1],
  [0, 0],
];

export function runTerrainStub(): void {
  const world = new World();
  const buffer = new SnapshotBuffer();
  const predictor = new LocalPredictor();
  const terrain = buildStubTerrain();

  const renderer = new Renderer(
    world,
    buffer,
    predictor,
    document.body,
    {
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
    },
    terrain,
  );
  window.addEventListener("resize", () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  });
}

/**
 * Build the four default chunks with a deterministic, eyeballable pattern:
 *
 *   - ground: checkerboard alternating `Grass` / `Stone` per tile (server
 *     +x parity ⊕ +y parity), so chunk seams are easy to spot,
 *   - top: `Wood` "trees" at a few fixed local coords per chunk so the
 *     upright top-block meshes are visible.
 *
 * Pure of any DOM / Three.js — exported for tests if we want to add any.
 */
export function buildStubTerrain(): Terrain {
  const t = new Terrain();
  for (const [cx, cy] of DEFAULT_CHUNK_COORDS) {
    t.insert(cx, cy, buildPatternedChunk(cx, cy));
  }
  return t;
}

function buildPatternedChunk(cx: number, cy: number): Chunk {
  const c = emptyChunk();
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      // Use world-tile parity (not local parity) so the checkerboard
      // continues seamlessly across chunk boundaries.
      const wx = cx * CHUNK_SIZE + x;
      const wy = cy * CHUNK_SIZE + y;
      const checker = (((wx & 1) ^ (wy & 1)) === 0);
      setBlock(c.ground, x, y, {
        kind: checker ? BlockType.Grass : BlockType.Stone,
      });
    }
  }
  for (const [tx, ty] of [
    [3, 3],
    [8, 8],
    [12, 4],
    [4, 12],
  ] as const) {
    setBlock(c.top, tx, ty, { kind: BlockType.Wood });
  }
  return c;
}
