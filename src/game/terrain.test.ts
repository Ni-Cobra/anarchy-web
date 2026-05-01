import { describe, expect, it } from "vitest";

import {
  AIR_BLOCK,
  BlockType,
  CHUNK_SIZE,
  LAYER_AREA,
  LAYER_SIZE,
  Terrain,
  chunkCoordForWorldPos,
  chunkKey,
  emptyChunk,
  emptyLayer,
  filledLayer,
  getBlock,
  layerIdx,
  parseChunkKey,
  setBlock,
} from "./terrain.js";

describe("constants", () => {
  it("LAYER_SIZE is 16 and LAYER_AREA is 256", () => {
    expect(LAYER_SIZE).toBe(16);
    expect(LAYER_AREA).toBe(256);
  });

  it("CHUNK_SIZE matches LAYER_SIZE", () => {
    expect(CHUNK_SIZE).toBe(LAYER_SIZE);
  });
});

describe("layerIdx", () => {
  it("round-trips bijectively over the full 16×16 layer", () => {
    // (x, y) → idx → (idx % 16, idx / 16) recovers the original coord, and
    // every coord maps to a distinct index in [0, LAYER_AREA). Pin it.
    const seen = new Set<number>();
    for (let y = 0; y < LAYER_SIZE; y++) {
      for (let x = 0; x < LAYER_SIZE; x++) {
        const i = layerIdx(x, y);
        expect(i).toBe(y * LAYER_SIZE + x);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(LAYER_AREA);
        expect(i % LAYER_SIZE).toBe(x);
        expect(Math.floor(i / LAYER_SIZE)).toBe(y);
        expect(seen.has(i)).toBe(false);
        seen.add(i);
      }
    }
    expect(seen.size).toBe(LAYER_AREA);
  });

  it("throws on out-of-range x", () => {
    expect(() => layerIdx(LAYER_SIZE, 0)).toThrow(/layer x out of bounds/);
    expect(() => layerIdx(-1, 0)).toThrow(/layer x out of bounds/);
  });

  it("throws on out-of-range y", () => {
    expect(() => layerIdx(0, LAYER_SIZE)).toThrow(/layer y out of bounds/);
    expect(() => layerIdx(0, -1)).toThrow(/layer y out of bounds/);
  });

  it("throws on non-integer coords", () => {
    expect(() => layerIdx(1.5, 0)).toThrow(/layer x out of bounds/);
    expect(() => layerIdx(0, 1.5)).toThrow(/layer y out of bounds/);
  });
});

describe("emptyLayer / filledLayer / get / set", () => {
  it("empty layer is all Air", () => {
    const l = emptyLayer();
    expect(l.blocks.length).toBe(LAYER_AREA);
    for (let y = 0; y < LAYER_SIZE; y++) {
      for (let x = 0; x < LAYER_SIZE; x++) {
        expect(getBlock(l, x, y)).toEqual(AIR_BLOCK);
      }
    }
  });

  it("filled layer is uniform", () => {
    const l = filledLayer(BlockType.Stone);
    for (let y = 0; y < LAYER_SIZE; y++) {
      for (let x = 0; x < LAYER_SIZE; x++) {
        expect(getBlock(l, x, y).kind).toBe(BlockType.Stone);
      }
    }
  });

  it("get/set round-trips at each corner without disturbing the interior", () => {
    const l = emptyLayer();
    const max = LAYER_SIZE - 1;
    setBlock(l, 0, 0, { kind: BlockType.Grass });
    setBlock(l, max, 0, { kind: BlockType.Wood });
    setBlock(l, 0, max, { kind: BlockType.Stone });
    setBlock(l, max, max, { kind: BlockType.Grass });
    expect(getBlock(l, 0, 0).kind).toBe(BlockType.Grass);
    expect(getBlock(l, max, 0).kind).toBe(BlockType.Wood);
    expect(getBlock(l, 0, max).kind).toBe(BlockType.Stone);
    expect(getBlock(l, max, max).kind).toBe(BlockType.Grass);
    expect(getBlock(l, 5, 5)).toEqual(AIR_BLOCK);
  });

  it("set overwrites in place", () => {
    const l = emptyLayer();
    setBlock(l, 3, 4, { kind: BlockType.Grass });
    expect(getBlock(l, 3, 4).kind).toBe(BlockType.Grass);
    setBlock(l, 3, 4, { kind: BlockType.Stone });
    expect(getBlock(l, 3, 4).kind).toBe(BlockType.Stone);
  });
});

describe("emptyChunk", () => {
  it("has two independently-mutable Air layers", () => {
    const c = emptyChunk();
    setBlock(c.ground, 2, 3, { kind: BlockType.Grass });
    setBlock(c.top, 2, 3, { kind: BlockType.Wood });
    expect(getBlock(c.ground, 2, 3).kind).toBe(BlockType.Grass);
    expect(getBlock(c.top, 2, 3).kind).toBe(BlockType.Wood);
    // Mutating ground does not touch top.
    setBlock(c.ground, 2, 3, { kind: BlockType.Stone });
    expect(getBlock(c.top, 2, 3).kind).toBe(BlockType.Wood);
    expect(getBlock(c.ground, 2, 3).kind).toBe(BlockType.Stone);
  });
});

describe("chunkKey / parseChunkKey", () => {
  it("round-trips coords through the string form", () => {
    for (const [cx, cy] of [
      [0, 0],
      [1, 2],
      [-3, 4],
      [-7, -7],
      [12345, -67890],
    ] as const) {
      const k = chunkKey(cx, cy);
      expect(k).toBe(`${cx},${cy}`);
      expect(parseChunkKey(k)).toEqual([cx, cy]);
    }
  });

  it("two coords produce identical strings (for Map key dedup)", () => {
    expect(chunkKey(3, -4)).toBe(chunkKey(3, -4));
    expect(chunkKey(3, -4)).not.toBe(chunkKey(-4, 3));
  });

  it("chunkKey throws on non-integer coords", () => {
    expect(() => chunkKey(1.5, 0)).toThrow(/chunk coord must be integer/);
    expect(() => chunkKey(0, NaN)).toThrow(/chunk coord must be integer/);
  });

  it("parseChunkKey throws on malformed input", () => {
    expect(() => parseChunkKey("abc")).toThrow(/malformed chunk key/);
    expect(() => parseChunkKey("1,")).toThrow(/malformed chunk key/);
    expect(() => parseChunkKey(",1")).toThrow(/malformed chunk key/);
    expect(() => parseChunkKey("1,2,3")).toThrow(/malformed chunk key/);
  });
});

describe("chunkCoordForWorldPos", () => {
  it("origin is (0, 0)", () => {
    expect(chunkCoordForWorldPos(0, 0)).toEqual([0, 0]);
  });

  it("first positive chunk stays at (0, 0)", () => {
    expect(chunkCoordForWorldPos(0.5, 0.5)).toEqual([0, 0]);
    expect(chunkCoordForWorldPos(CHUNK_SIZE - 0.001, 0)).toEqual([0, 0]);
    expect(chunkCoordForWorldPos(0, CHUNK_SIZE - 0.001)).toEqual([0, 0]);
  });

  it("negative positions floor toward -∞ — pinned ADR 0002 invariant", () => {
    // Truncate-toward-zero would silently miss the south-west chunks;
    // floor is the correct convention.
    expect(chunkCoordForWorldPos(-0.5, -0.5)).toEqual([-1, -1]);
    expect(chunkCoordForWorldPos(-0.001, -0.001)).toEqual([-1, -1]);
    expect(chunkCoordForWorldPos(-15.999, -0.5)).toEqual([-1, -1]);
  });

  it("negative chunk boundary belongs to the chunk to its east/north", () => {
    // -16 sits on the boundary between chunks (-2, …) and (-1, …); floor
    // convention puts it in (-1, …) (which covers world tiles -16 .. 0).
    expect(chunkCoordForWorldPos(-CHUNK_SIZE, 0)).toEqual([-1, 0]);
    expect(chunkCoordForWorldPos(-CHUNK_SIZE - 0.001, 0)).toEqual([-2, 0]);
  });

  it("positive chunk boundary belongs to the chunk to its east/north", () => {
    // 16 sits on the boundary between (0, …) and (1, …); belongs to
    // (1, …) (which covers tiles 16 .. 32).
    expect(chunkCoordForWorldPos(CHUNK_SIZE, 0)).toEqual([1, 0]);
  });

  it("far from origin: 100/16 → 6, -100/16 → -7", () => {
    expect(chunkCoordForWorldPos(100, -100)).toEqual([6, -7]);
  });

  it("axes are independent", () => {
    expect(chunkCoordForWorldPos(20, -5)).toEqual([1, -1]);
    expect(chunkCoordForWorldPos(-5, 20)).toEqual([-1, 1]);
  });
});

describe("Terrain", () => {
  it("starts empty", () => {
    const t = new Terrain();
    expect(t.isEmpty()).toBe(true);
    expect(t.size()).toBe(0);
    expect(t.get(0, 0)).toBeUndefined();
    expect(t.contains(0, 0)).toBe(false);
  });

  it("insert/get round-trips and reports replaced chunk", () => {
    const t = new Terrain();
    expect(t.insert(1, -2, emptyChunk())).toBeUndefined();
    expect(t.contains(1, -2)).toBe(true);
    expect(t.size()).toBe(1);
    expect(t.get(1, -2)).toBeDefined();
    // Re-inserting at the same coord returns the previous chunk.
    expect(t.insert(1, -2, emptyChunk())).toBeDefined();
    expect(t.size()).toBe(1);
  });

  it("remove returns the chunk then misses", () => {
    const t = new Terrain();
    t.insert(0, 0, emptyChunk());
    expect(t.remove(0, 0)).toBeDefined();
    expect(t.get(0, 0)).toBeUndefined();
    expect(t.remove(0, 0)).toBeUndefined();
  });

  it("iter visits every loaded chunk", () => {
    const t = new Terrain();
    t.insert(0, 0, emptyChunk());
    t.insert(1, 2, emptyChunk());
    t.insert(-3, 4, emptyChunk());
    const coords: [number, number][] = [];
    for (const [coord] of t.iter()) {
      coords.push([coord[0], coord[1]]);
    }
    coords.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(coords).toEqual([
      [-3, 4],
      [0, 0],
      [1, 2],
    ]);
  });

  it("two coords with same string key collide in storage", () => {
    // Defensive: ES Map keys by reference for objects, but our string keys
    // mean two distinct calls to `insert(3, -4, …)` overwrite each other.
    const t = new Terrain();
    const first = emptyChunk();
    const second = emptyChunk();
    t.insert(3, -4, first);
    t.insert(3, -4, second);
    expect(t.size()).toBe(1);
    expect(t.get(3, -4)).toBe(second);
  });
});
