import { anarchy } from "../gen/anarchy.js";
import {
  type Block,
  BlockType,
  type Chunk,
  DEFAULT_FACING,
  Direction8,
  LAYER_AREA,
  type Layer,
  type LocalPredictor,
  type Player,
  type PlayerId,
  type SnapshotBuffer,
  type Terrain,
  type World,
} from "../game/index.js";

/**
 * The bridge through which the wire layer publishes (and reads back) the
 * local player id. The renderer needs to know which player is the local
 * one for color + camera; the predictor reconciliation needs to look up
 * the local player's entry inside each snapshot. The wire layer stays
 * networking-agnostic by funneling both through this hook rather than
 * holding state itself.
 */
export interface LocalPlayerSink {
  setLocalPlayerId(id: PlayerId | null): void;
  getLocalPlayerId(): PlayerId | null;
}

/**
 * Notifications for the renderer (or any other observer) when the
 * `Terrain` map mutates from the wire side. The wire layer mutates
 * `Terrain` first, then calls the matching hook so the renderer can
 * rebuild the affected sub-mesh. All hooks are optional — tests that
 * don't render can omit them.
 */
export interface TerrainSink {
  /** A bulk `TerrainSnapshot` was applied; the renderer should rebuild
   * its terrain mesh wholesale from the current `Terrain` contents. */
  onSnapshot?(): void;
  /** A single chunk at `(cx, cy)` was inserted or replaced. */
  onChunkLoaded?(cx: number, cy: number): void;
  /** A single chunk at `(cx, cy)` was removed. */
  onChunkUnloaded?(cx: number, cy: number): void;
}

export interface WireDeps {
  readonly world: World;
  readonly buffer: SnapshotBuffer;
  readonly local: LocalPlayerSink;
  /**
   * Local-player position predictor. The wire layer:
   *   - calls `reset(x, y)` from `ServerWelcome.snapshot` so prediction
   *     starts at the authoritative spawn position;
   *   - on every `StateUpdate`, hands the local player's snapshot entry
   *     (position + `acked_client_seq`) to `reconcile` so divergence with
   *     a server override gets snapped back.
   * Optional so existing tests that don't exercise prediction can omit it.
   */
  readonly predictor?: LocalPredictor;
  /**
   * Authoritative client-side mirror of the loaded chunk set. The wire
   * layer mutates this in place when terrain messages arrive. Optional
   * for tests that don't exercise terrain.
   */
  readonly terrain?: Terrain;
  /** Renderer notification hooks; see `TerrainSink`. */
  readonly terrainSink?: TerrainSink;
  /** Wall-clock for stamping samples. Override in tests. */
  readonly now?: () => number;
}

interface LocalSnapshotEntry {
  readonly x: number;
  readonly y: number;
  readonly ackedClientSeq: number;
}

/**
 * Translate one decoded `ServerMessage` into mutations on the game-state
 * mirror. This is the only place protobuf types touch `World` /
 * `SnapshotBuffer` / `LocalPredictor` / `LocalPlayerSink`.
 *
 * Per ADR 0001 every tick carries a full `WorldSnapshot`, so:
 *   - `ServerWelcome.snapshot` and `StateUpdate.snapshot` both feed
 *     `World.applySnapshot` (a full replace) and append one sample per
 *     player to the per-id history in `SnapshotBuffer`. Welcome also
 *     resets the predictor to the spawn position; subsequent state updates
 *     reconcile the predictor against the local player's authoritative
 *     entry.
 *   - `PlayerDespawned` removes the player from both stores immediately
 *     (the next tick wouldn't include them anyway, but acting on the
 *     explicit signal lets the mesh vanish without waiting ~50 ms).
 *   - `Welcome` also clears the buffer and re-binds the local id, so
 *     reconnects start clean.
 *
 * Other payloads (Pong, unknown oneof) are no-ops here — the connection
 * layer handles transport-level concerns like heartbeats.
 */
export function applyServerMessage(
  msg: anarchy.v1.IServerMessage,
  deps: WireDeps,
): void {
  const now = deps.now ?? Date.now;

  if (msg.welcome) {
    const w = msg.welcome;
    deps.buffer.clear();
    const localId = toNumber(w.playerId);
    deps.local.setLocalPlayerId(localId);
    if (w.snapshot) {
      const localEntry = ingestSnapshot(
        w.snapshot,
        deps.world,
        deps.buffer,
        localId,
        now(),
      );
      // Reset predictor to authoritative spawn (origin today, but cheap to
      // anchor on whatever the welcome snapshot says).
      if (deps.predictor) {
        deps.predictor.reset(localEntry?.x ?? 0, localEntry?.y ?? 0);
      }
    } else if (deps.predictor) {
      deps.predictor.reset(0, 0);
    }
    return;
  }

  if (msg.stateUpdate?.snapshot) {
    const localId = deps.local.getLocalPlayerId();
    const localEntry = ingestSnapshot(
      msg.stateUpdate.snapshot,
      deps.world,
      deps.buffer,
      localId,
      now(),
    );
    if (deps.predictor && localEntry) {
      deps.predictor.reconcile(
        localEntry.x,
        localEntry.y,
        localEntry.ackedClientSeq,
      );
    }
    return;
  }

  if (msg.playerDespawned) {
    const id = toNumber(msg.playerDespawned.playerId);
    deps.world.removePlayer(id);
    deps.buffer.drop(id);
    return;
  }

  if (msg.terrainSnapshot) {
    if (!deps.terrain) return;
    // Bulk replace: clear out anything currently loaded (defends against
    // reconnect leaving stale chunks) and ingest every chunk in the snapshot.
    // Iter() yields a live view, so collect coords first to avoid mutating
    // during iteration.
    const existing: Array<readonly [number, number]> = [];
    for (const [coord] of deps.terrain.iter()) existing.push(coord);
    for (const [cx, cy] of existing) deps.terrain.remove(cx, cy);
    for (const wireChunk of msg.terrainSnapshot.chunks ?? []) {
      const decoded = chunkFromWire(wireChunk);
      if (!decoded) continue;
      const [[cx, cy], chunk] = decoded;
      deps.terrain.insert(cx, cy, chunk);
    }
    deps.terrainSink?.onSnapshot?.();
    return;
  }

  if (msg.chunkLoaded?.chunk) {
    if (!deps.terrain) return;
    const decoded = chunkFromWire(msg.chunkLoaded.chunk);
    if (!decoded) return;
    const [[cx, cy], chunk] = decoded;
    deps.terrain.insert(cx, cy, chunk);
    deps.terrainSink?.onChunkLoaded?.(cx, cy);
    return;
  }

  if (msg.chunkUnloaded) {
    if (!deps.terrain) return;
    const cx = msg.chunkUnloaded.x ?? 0;
    const cy = msg.chunkUnloaded.y ?? 0;
    // `remove` is idempotent — safe to call for a chunk we never had
    // (e.g. an unload broadcast received before the joining `TerrainSnapshot`
    // landed, or a duplicate during a reconnect).
    deps.terrain.remove(cx, cy);
    deps.terrainSink?.onChunkUnloaded?.(cx, cy);
    return;
  }
}

/**
 * Decode one wire `Chunk` into game-side `(coord, Chunk)`. Returns `null`
 * if the wire chunk is malformed (missing layer or wrong block count) —
 * the server is canonical, but proto3 has no fixed-size repeated, so the
 * length is enforced here. A receiver that crashed on a bad message would
 * be a denial-of-service vector if we ever federated.
 */
function chunkFromWire(
  wire: anarchy.v1.IChunk,
): readonly [readonly [number, number], Chunk] | null {
  const cx = wire.x ?? 0;
  const cy = wire.y ?? 0;
  if (!wire.ground || !wire.top) return null;
  const ground = layerFromWire(wire.ground);
  const top = layerFromWire(wire.top);
  if (!ground || !top) return null;
  return [[cx, cy] as const, { ground, top }];
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
    case anarchy.v1.BlockType.BLOCK_TYPE_AIR:
    default:
      // AIR is the proto3 default and the natural identity element. Any
      // unknown future variant decays to AIR rather than crashing — the
      // chunk still renders (as a hole), and the user-visible failure mode
      // is "missing tile" rather than "blank screen".
      return BlockType.Air;
  }
}

/**
 * Ingest a snapshot into world + buffer, returning the local player's
 * entry (if `localId` is provided and present in the snapshot) so the
 * caller can drive reconciliation without re-walking the snapshot.
 */
function ingestSnapshot(
  snapshot: anarchy.v1.IWorldSnapshot,
  world: World,
  buffer: SnapshotBuffer,
  localId: PlayerId | null,
  timeMs: number,
): LocalSnapshotEntry | null {
  const players: Player[] = (snapshot.players ?? []).map((p) => ({
    id: toNumber(p.id),
    x: p.x ?? 0,
    y: p.y ?? 0,
    facing: facingFromWire(p.facing),
  }));
  world.applySnapshot(players);
  for (const p of players) {
    buffer.push(p.id, p.x, p.y, timeMs);
  }
  if (localId === null) return null;
  for (const p of snapshot.players ?? []) {
    if (toNumber(p.id) === localId) {
      return {
        x: p.x ?? 0,
        y: p.y ?? 0,
        ackedClientSeq: toNumber(p.ackedClientSeq),
      };
    }
  }
  return null;
}


/**
 * Coerce a protobuf uint64 field (number | Long | null | undefined) into a
 * plain JS number. Player ids and seq numbers fit comfortably in 53 bits in
 * practice, so the truncation isn't a real concern at our scale.
 */
function toNumber(
  v: number | { toNumber(): number } | null | undefined,
): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return v.toNumber();
}

/**
 * Translate the proto `Direction8` enum int into the client `Direction8`
 * (whose numeric values intentionally match the wire). `UNSPECIFIED` and
 * any unknown value fall back to [`DEFAULT_FACING`] — the server never
 * emits `UNSPECIFIED`, but a defensive default keeps the client safe if the
 * schema ever drifts ahead.
 */
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
