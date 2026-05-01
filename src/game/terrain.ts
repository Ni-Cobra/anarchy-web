/**
 * Client-side mirror of the server's `game::terrain` data model. Pure data +
 * math; no networking. The shape (block kinds, layer size, two-layer chunks,
 * sparse `Terrain` map) tracks ADR 0002 in the server repo — see
 * `anarchy-server/docs/decisions/0002-terrain-model.md` — so the next
 * networking task can map the proto schema 1:1 onto these types.
 *
 * The `Terrain` map is keyed by a `"cx,cy"` string under the hood (ES Maps
 * compare object keys by reference, so a tuple key would be useless); the
 * public API takes plain `(cx, cy)` numbers and never exposes the string.
 */

/**
 * Kind of a single block. Numeric values match the planned proto enum
 * (`Air = 0` is the proto3 default sentinel) so a future `BlockType` field
 * on the wire can be cast directly.
 */
export enum BlockType {
  Air = 0,
  Grass = 1,
  Wood = 2,
  Stone = 3,
}

/**
 * One tile. The `kind` field is the only thing carried today; future
 * metadata (variant, hp, owner, lighting, …) attaches here, mirroring the
 * server's `Block` struct rather than collapsing to a bare enum.
 */
export interface Block {
  readonly kind: BlockType;
}

/** Pre-built `{ kind: Air }`. Convenient for default-filling layers. */
export const AIR_BLOCK: Block = Object.freeze({ kind: BlockType.Air });

/** Tile-side length of a layer, in blocks. */
export const LAYER_SIZE = 16;

/** Number of blocks in a layer (`LAYER_SIZE * LAYER_SIZE`). */
export const LAYER_AREA = LAYER_SIZE * LAYER_SIZE;

/**
 * Tile-side length of a chunk. Equal to `LAYER_SIZE` — every chunk is one
 * `LAYER_SIZE × LAYER_SIZE` square per layer.
 */
export const CHUNK_SIZE = LAYER_SIZE;

/**
 * Map a local 2D layer coordinate to a flat-array index. The layer has
 * fixed dimensions, so out-of-range coords are a programmer error and
 * throw — mirrors the server `Layer::idx` panic.
 */
export function layerIdx(x: number, y: number): number {
  if (!Number.isInteger(x) || x < 0 || x >= LAYER_SIZE) {
    throw new RangeError(`layer x out of bounds: ${x}`);
  }
  if (!Number.isInteger(y) || y < 0 || y >= LAYER_SIZE) {
    throw new RangeError(`layer y out of bounds: ${y}`);
  }
  return y * LAYER_SIZE + x;
}

/**
 * One horizontal slab of blocks. A `Chunk` is two stacked `Layer`s
 * (`ground` + `top`). The flat array (rather than nested arrays) matches
 * the server's `[Block; LAYER_AREA]` layout 1:1.
 */
export interface Layer {
  readonly blocks: Block[];
}

export function emptyLayer(): Layer {
  const blocks = new Array<Block>(LAYER_AREA);
  for (let i = 0; i < LAYER_AREA; i++) blocks[i] = AIR_BLOCK;
  return { blocks };
}

export function filledLayer(kind: BlockType): Layer {
  const block: Block = { kind };
  const blocks = new Array<Block>(LAYER_AREA);
  for (let i = 0; i < LAYER_AREA; i++) blocks[i] = block;
  return { blocks };
}

export function getBlock(layer: Layer, x: number, y: number): Block {
  return layer.blocks[layerIdx(x, y)];
}

export function setBlock(layer: Layer, x: number, y: number, block: Block): void {
  layer.blocks[layerIdx(x, y)] = block;
}

/**
 * One chunk: walkable `ground` floor + sparse `top` standing geometry.
 * Naming mirrors the server `Chunk { ground, top }`.
 */
export interface Chunk {
  readonly ground: Layer;
  readonly top: Layer;
}

export function emptyChunk(): Chunk {
  return { ground: emptyLayer(), top: emptyLayer() };
}

/**
 * Stable string key for a chunk-coord pair. Pinned format `"cx,cy"` so
 * round-tripping through `parseChunkKey` is exact. ES `Map` compares object
 * keys by identity, so a tuple key wouldn't share storage between two
 * `[cx, cy]` arrays — a string key is the lowest-friction option.
 */
export function chunkKey(cx: number, cy: number): string {
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
    throw new RangeError(`chunk coord must be integer: (${cx}, ${cy})`);
  }
  return `${cx},${cy}`;
}

export function parseChunkKey(key: string): readonly [number, number] {
  const comma = key.indexOf(",");
  if (comma <= 0 || comma === key.length - 1) {
    throw new RangeError(`malformed chunk key: ${key}`);
  }
  const cx = Number(key.slice(0, comma));
  const cy = Number(key.slice(comma + 1));
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
    throw new RangeError(`malformed chunk key: ${key}`);
  }
  return [cx, cy] as const;
}

/**
 * Map a continuous world position to the chunk-coord that contains it. Uses
 * `Math.floor`, not truncate-toward-zero, so negative positions land in the
 * chunk to the south-west of origin (e.g. `(-0.5, -0.5)` → `(-1, -1)`).
 * Mirrors the server's `chunk_coord_for_world_pos`.
 */
export function chunkCoordForWorldPos(
  x: number,
  y: number,
): readonly [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
}

/**
 * Authoritative collection of loaded chunks, keyed by `(chunk_x, chunk_y)`.
 * Iteration order is insertion order (ES `Map` semantics) — callers that
 * need a specific order should sort.
 *
 * Mirrors `game::Terrain` on the server; networking and the per-chunk
 * load/unload policy attach in follow-up BACKLOG tasks.
 */
export class Terrain {
  private readonly chunks = new Map<string, Chunk>();

  /** Insert or replace the chunk at `(cx, cy)`. Returns the previous chunk. */
  insert(cx: number, cy: number, chunk: Chunk): Chunk | undefined {
    const k = chunkKey(cx, cy);
    const prev = this.chunks.get(k);
    this.chunks.set(k, chunk);
    return prev;
  }

  remove(cx: number, cy: number): Chunk | undefined {
    const k = chunkKey(cx, cy);
    const prev = this.chunks.get(k);
    if (prev === undefined) return undefined;
    this.chunks.delete(k);
    return prev;
  }

  get(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  contains(cx: number, cy: number): boolean {
    return this.chunks.has(chunkKey(cx, cy));
  }

  size(): number {
    return this.chunks.size;
  }

  isEmpty(): boolean {
    return this.chunks.size === 0;
  }

  /** Iterate over every loaded chunk and its coord. */
  *iter(): IterableIterator<readonly [readonly [number, number], Chunk]> {
    for (const [k, chunk] of this.chunks) {
      yield [parseChunkKey(k), chunk] as const;
    }
  }
}
