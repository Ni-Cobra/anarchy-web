import { anarchy } from "../gen/anarchy.js";
import {
  type Block,
  BlockType,
  type Chunk,
  type ChunkCoord,
  DEFAULT_FACING,
  Direction8,
  INVENTORY_SIZE,
  type Inventory,
  ItemId,
  LAYER_AREA,
  type Layer,
  type Player,
  type PlayerId,
  type SnapshotBuffer,
  type Slot,
  type Terrain,
  type World,
} from "../game/index.js";

/**
 * The bridge through which the wire layer publishes (and reads back) the
 * local player id. The renderer needs to know which player is the local
 * one for color + camera; nothing else outside the wire layer reads the id
 * back, but the hook keeps this module networking-agnostic.
 */
export interface LocalPlayerSink {
  setLocalPlayerId(id: PlayerId | null): void;
  getLocalPlayerId(): PlayerId | null;
}

/**
 * Notifications for the renderer (or any other observer) when chunks
 * mutate from the wire side. Per ADR 0003 every per-tick update may
 * insert new chunks (full state), keep some unchanged, or implicitly
 * unload chunks that fell out of view; the renderer rebuilds the affected
 * sub-meshes after each tick.
 */
export interface TerrainSink {
  /** A chunk at `(cx, cy)` was inserted or replaced (full state). */
  onChunkLoaded?(cx: number, cy: number): void;
  /** A chunk at `(cx, cy)` was implicitly unloaded (fell out of view). */
  onChunkUnloaded?(cx: number, cy: number): void;
}

export interface WireDeps {
  readonly world: World;
  readonly buffer: SnapshotBuffer;
  readonly local: LocalPlayerSink;
  /**
   * Authoritative client-side mirror of the loaded chunk set. The wire
   * layer mutates this in place when `TickUpdate` arrives. Optional for
   * tests that don't exercise terrain.
   */
  readonly terrain?: Terrain;
  /** Renderer notification hooks; see `TerrainSink`. */
  readonly terrainSink?: TerrainSink;
  /**
   * Local-player inventory mirror. Mutated in place when `InventoryUpdate`
   * arrives. Per-player only — the server never ships another player's
   * inventory, so this is always the local player's view. Optional for
   * tests that don't exercise inventory.
   */
  readonly inventory?: Inventory;
  /** Wall-clock for stamping samples. Override in tests. */
  readonly now?: () => number;
}

/**
 * Translate one decoded `ServerMessage` into mutations on the game-state
 * mirror. This is the only place protobuf types touch `World` /
 * `SnapshotBuffer` / `Terrain` / `LocalPlayerSink`.
 *
 * Per ADR 0003 the steady-state wire shape is `TickUpdate`:
 *   - `full_state_chunks` carries chunks newly entering the view window
 *     OR known chunks whose state changed this tick. Each chunk includes
 *     its terrain layers AND the players whose center currently falls
 *     inside it. The wire layer overwrites the matching `Terrain` entry
 *     and pushes one snapshot-buffer sample per player in the chunk.
 *   - `unmodified_chunks` is an explicit list of "still in view, no
 *     state change this tick"; receivers leave these alone.
 *   - Implicit unload: any chunk in the receiver's last-known view that
 *     does not appear in either field is dropped.
 *
 * After applying the tick, the World is replaced wholesale with the union
 * of players across the post-tick terrain, so any player whose chunk
 * dropped out of view (or who left the chunk to a neighbor we've also
 * dropped) disappears the same way.
 */
export function applyServerMessage(
  msg: anarchy.v1.IServerMessage,
  deps: WireDeps,
): void {
  const now = deps.now ?? Date.now;

  if (msg.welcome) {
    const localId = toNumber(msg.welcome.playerId);
    deps.local.setLocalPlayerId(localId);
    deps.buffer.clear();
    if (deps.terrain) {
      // Reconnects start from an empty known set; clear any leftover
      // chunks from a previous session.
      const stale: ChunkCoord[] = [];
      for (const [coord] of deps.terrain.iter()) stale.push(coord);
      for (const [cx, cy] of stale) {
        deps.terrain.remove(cx, cy);
        deps.terrainSink?.onChunkUnloaded?.(cx, cy);
      }
    }
    deps.world.applySnapshot([]);
    return;
  }

  if (msg.tickUpdate) {
    applyTickUpdate(msg.tickUpdate, deps, now());
    return;
  }

  if (msg.inventoryUpdate) {
    applyInventoryUpdate(msg.inventoryUpdate, deps);
    return;
  }
}

function applyInventoryUpdate(
  update: anarchy.v1.IInventoryUpdate,
  deps: WireDeps,
): void {
  if (!deps.inventory) return;
  const wireSlots = update.slots ?? [];
  if (wireSlots.length !== INVENTORY_SIZE) {
    // Defensive: a misbehaving server could ship the wrong slot count.
    // Drop the frame rather than corrupt local state.
    return;
  }
  const slots: Slot[] = wireSlots.map((s): Slot => {
    const count = s.count ?? 0;
    if (count === 0) return null;
    const item = itemIdFromWire(s.item);
    if (item === null) return null;
    return { item, count };
  });
  deps.inventory.replaceFromWire(slots);
}

function itemIdFromWire(
  item: anarchy.v1.ItemId | null | undefined,
): ItemId | null {
  switch (item) {
    case anarchy.v1.ItemId.ITEM_ID_STICK:
      return ItemId.Stick;
    case anarchy.v1.ItemId.ITEM_ID_WOOD:
      return ItemId.Wood;
    case anarchy.v1.ItemId.ITEM_ID_STONE:
      return ItemId.Stone;
    case anarchy.v1.ItemId.ITEM_ID_GOLD:
      return ItemId.Gold;
    default:
      return null;
  }
}

function applyTickUpdate(
  tick: anarchy.v1.ITickUpdate,
  deps: WireDeps,
  timeMs: number,
): void {
  const fullStateChunks = tick.fullStateChunks ?? [];
  const unmodifiedChunks = tick.unmodifiedChunks ?? [];

  // Compute the new known window (full + unmodified). Anything in the
  // current terrain that's not in the window will be implicitly unloaded.
  const newWindow = new Set<string>();
  for (const wireChunk of fullStateChunks) {
    const c = wireChunk.coord;
    if (!c) continue;
    newWindow.add(coordKey(c.cx ?? 0, c.cy ?? 0));
  }
  for (const c of unmodifiedChunks) {
    newWindow.add(coordKey(c.cx ?? 0, c.cy ?? 0));
  }

  if (deps.terrain) {
    // Implicit unload: drop chunks no longer in view.
    const stale: ChunkCoord[] = [];
    for (const [coord] of deps.terrain.iter()) {
      const [cx, cy] = coord;
      if (!newWindow.has(coordKey(cx, cy))) stale.push([cx, cy]);
    }
    for (const [cx, cy] of stale) {
      deps.terrain.remove(cx, cy);
      deps.terrainSink?.onChunkUnloaded?.(cx, cy);
    }
  }

  // Apply each full-state chunk and push samples for its players.
  for (const wireChunk of fullStateChunks) {
    const decoded = chunkFromWire(wireChunk);
    if (!decoded) continue;
    const [[cx, cy], chunk] = decoded;
    if (deps.terrain) {
      deps.terrain.insert(cx, cy, chunk);
      deps.terrainSink?.onChunkLoaded?.(cx, cy);
    }
    for (const p of chunk.players.values()) {
      deps.buffer.push(p.id, p.x, p.y, timeMs);
    }
  }

  // Rebuild the World player set from the union across post-tick terrain.
  // Players whose chunk fell out of view (or whose chunk no longer
  // references them) drop out automatically.
  const players: Player[] = [];
  if (deps.terrain) {
    for (const [, chunk] of deps.terrain.iter()) {
      for (const p of chunk.players.values()) players.push(p);
    }
  } else {
    // Without a terrain reference, fall back to just the players in this
    // tick's full-state chunks. Tests that don't exercise terrain hit
    // this path.
    for (const wireChunk of fullStateChunks) {
      const decoded = chunkFromWire(wireChunk);
      if (!decoded) continue;
      for (const p of decoded[1].players.values()) players.push(p);
    }
  }
  deps.world.applySnapshot(players);

  // Drop buffer entries for ids no longer in view.
  const visible = new Set(players.map((p) => p.id));
  for (const id of deps.buffer.knownIds()) {
    if (!visible.has(id)) deps.buffer.drop(id);
  }
}

function chunkFromWire(
  wire: anarchy.v1.IChunk,
): readonly [ChunkCoord, Chunk] | null {
  const coord = wire.coord;
  if (!coord) return null;
  const cx = coord.cx ?? 0;
  const cy = coord.cy ?? 0;
  if (!wire.ground || !wire.top) return null;
  const ground = layerFromWire(wire.ground);
  const top = layerFromWire(wire.top);
  if (!ground || !top) return null;
  const players = new Map<PlayerId, Player>();
  for (const p of wire.players ?? []) {
    const id = toNumber(p.id);
    players.set(id, {
      id,
      x: p.x ?? 0,
      y: p.y ?? 0,
      facing: facingFromWire(p.facing),
      username: p.username ?? "",
      colorIndex: p.colorIndex ?? 0,
    });
  }
  return [[cx, cy] as const, { ground, top, players }];
}

function layerFromWire(wire: anarchy.v1.ILayer): Layer | null {
  const wireBlocks = wire.blocks ?? [];
  if (wireBlocks.length !== LAYER_AREA) return null;
  const blocks = new Array<Block>(LAYER_AREA);
  for (let i = 0; i < LAYER_AREA; i++) {
    blocks[i] = blockFromWire(wireBlocks[i]);
  }
  return { blocks };
}

function blockFromWire(wire: anarchy.v1.IBlock): Block {
  return { kind: blockTypeFromWire(wire.kind) };
}

function blockTypeFromWire(
  kind: anarchy.v1.BlockType | null | undefined,
): BlockType {
  switch (kind) {
    case anarchy.v1.BlockType.BLOCK_TYPE_GRASS:
      return BlockType.Grass;
    case anarchy.v1.BlockType.BLOCK_TYPE_WOOD:
      return BlockType.Wood;
    case anarchy.v1.BlockType.BLOCK_TYPE_STONE:
      return BlockType.Stone;
    case anarchy.v1.BlockType.BLOCK_TYPE_GOLD:
      return BlockType.Gold;
    case anarchy.v1.BlockType.BLOCK_TYPE_TREE:
      return BlockType.Tree;
    case anarchy.v1.BlockType.BLOCK_TYPE_STICKS:
      return BlockType.Sticks;
    case anarchy.v1.BlockType.BLOCK_TYPE_AIR:
    default:
      return BlockType.Air;
  }
}

/**
 * Translate the local `BlockType` enum to its proto-side counterpart. The
 * two enums use identical numeric values today — see `terrain.ts` — but
 * they are nominally distinct TS types, so callers building outbound
 * `IClientMessage` payloads need this for the kind field on `PlaceBlock`.
 * Lives here so `main.ts` doesn't reach into `../gen/anarchy.js`.
 */
export function blockTypeToWire(kind: BlockType): anarchy.v1.BlockType {
  switch (kind) {
    case BlockType.Air:
      return anarchy.v1.BlockType.BLOCK_TYPE_AIR;
    case BlockType.Grass:
      return anarchy.v1.BlockType.BLOCK_TYPE_GRASS;
    case BlockType.Wood:
      return anarchy.v1.BlockType.BLOCK_TYPE_WOOD;
    case BlockType.Stone:
      return anarchy.v1.BlockType.BLOCK_TYPE_STONE;
    case BlockType.Gold:
      return anarchy.v1.BlockType.BLOCK_TYPE_GOLD;
    case BlockType.Tree:
      return anarchy.v1.BlockType.BLOCK_TYPE_TREE;
    case BlockType.Sticks:
      return anarchy.v1.BlockType.BLOCK_TYPE_STICKS;
  }
}

function coordKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function toNumber(
  v: number | { toNumber(): number } | null | undefined,
): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return v.toNumber();
}

function facingFromWire(facing: anarchy.v1.Direction8 | null | undefined): Direction8 {
  switch (facing) {
    case anarchy.v1.Direction8.DIRECTION8_N:
      return Direction8.N;
    case anarchy.v1.Direction8.DIRECTION8_NE:
      return Direction8.NE;
    case anarchy.v1.Direction8.DIRECTION8_E:
      return Direction8.E;
    case anarchy.v1.Direction8.DIRECTION8_SE:
      return Direction8.SE;
    case anarchy.v1.Direction8.DIRECTION8_S:
      return Direction8.S;
    case anarchy.v1.Direction8.DIRECTION8_SW:
      return Direction8.SW;
    case anarchy.v1.Direction8.DIRECTION8_W:
      return Direction8.W;
    case anarchy.v1.Direction8.DIRECTION8_NW:
      return Direction8.NW;
    default:
      return DEFAULT_FACING;
  }
}
