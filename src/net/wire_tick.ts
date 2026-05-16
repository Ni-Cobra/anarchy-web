/**
 * `TickUpdate` message handler — the per-tick state-sync workhorse.
 *
 * Per ADR 0003 the steady-state wire shape is `TickUpdate`:
 *   - `full_state_chunks` carries chunks newly entering the view window
 *     OR known chunks whose state changed this tick. Each chunk includes
 *     its terrain layers AND the players whose center currently falls
 *     inside it. The handler overwrites the matching `Terrain` entry and
 *     pushes one snapshot-buffer sample per player in the chunk.
 *   - `unmodified_chunks` is an explicit list of "still in view, no state
 *     change this tick"; receivers leave these alone.
 *   - Implicit unload: any chunk in the receiver's last-known view that
 *     does not appear in either field is dropped.
 *
 * After applying the tick, the World is replaced wholesale with the union
 * of players across the post-tick terrain, so any player whose chunk
 * dropped out of view (or who left the chunk to a neighbor we've also
 * dropped) disappears the same way.
 *
 * The per-tick effects feed (task 070) — `tick.edits` (block place/break
 * one-shots) and `tick.targets` (held-break progress, an authoritative
 * replace) — is fanned out through `EffectsSink` so the renderer can
 * spawn / advance / cull its visuals without the bridge importing
 * `three`.
 */
import { anarchy } from "../gen/anarchy.js";
import {
  type Block,
  type BlockType,
  type Chunk,
  type ChunkCoord,
  type Entity,
  type EntityId,
  EntityKind,
  LAYER_AREA,
  type Layer,
  LAYER_SIZE,
  type Player,
  type PlayerId,
} from "../game/index.js";
import { MAX_PLAYER_HEALTH, type OpenChestRef } from "../game/player.js";
import { maxHealthForKind } from "../game/entity.js";

import type { WireDeps } from "./wire.js";
import {
  blockTypeFromWire,
  coordKey,
  facingFromWire,
  toNumber,
} from "./wire_codec.js";
import { itemIdFromWire } from "./wire_inventory.js";

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

/**
 * Per-tick block-edit + targeting feed (task 070). The wire layer reads
 * the new `TickUpdate.edits` / `TickUpdate.targets` fields and routes
 * them here so the renderer can spawn / advance / cull effects without
 * the bridge importing `three`. The shape mirrors
 * `render/effects.BlockEditEvent` / `TargetingStateEvent` so the bridge
 * stays free of `three`-dependent types.
 */
export type WireBlockEditKind = "placed" | "broken";
export interface WireBlockEditEvent {
  readonly playerId: number;
  readonly kind: WireBlockEditKind;
  readonly cx: number;
  readonly cy: number;
  readonly lx: number;
  readonly ly: number;
  /**
   * The top-layer block kind involved in this edit — placed kind for
   * `placed`, removed kind for `broken`. Mirrors `BlockEdit.block_type`
   * on the wire and lets the renderer specialize visuals (e.g. the
   * break-particle tint) without re-reading the chunk.
   */
  readonly blockType: BlockType;
}
export interface WireTargetingStateEvent {
  readonly playerId: number;
  readonly cx: number;
  readonly cy: number;
  readonly lx: number;
  readonly ly: number;
  readonly durabilityPct: number;
}
export interface EffectsSink {
  onBlockEdit?(event: WireBlockEditEvent): void;
  applyTargets?(targets: readonly WireTargetingStateEvent[]): void;
}

/**
 * Day-cycle hook (task 310). Each tick the server ships a monotonically
 * growing `time_of_day_seconds` scalar; the wire layer plumbs it here so
 * the renderer can drive the directional sun + ambient envelope from a
 * server-authoritative clock. Optional — tests / headless paths leave
 * it absent and the bridge silently drops the value.
 */
export interface DaylightSink {
  onTimeOfDay?(seconds: number): void;
}

export function applyTickUpdate(
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

  // Apply each full-state chunk and push samples for its players. Insert
  // every chunk into `terrain` first, then fan out `onChunkLoaded` in a
  // second pass — the renderer reads neighbour chunks via `terrain` during
  // mesh build (Hidden-AO pass, task 290), so we want sibling chunks
  // arriving in the same tick to be visible to each other.
  const inserted: ChunkCoord[] = [];
  for (const wireChunk of fullStateChunks) {
    const decoded = chunkFromWire(wireChunk);
    if (!decoded) continue;
    const [[cx, cy], chunk] = decoded;
    if (deps.terrain) {
      deps.terrain.insert(cx, cy, chunk);
      inserted.push([cx, cy]);
    }
    for (const p of chunk.players.values()) {
      deps.buffer.push(p.id, p.x, p.y, timeMs);
    }
  }
  for (const [cx, cy] of inserted) {
    deps.terrainSink?.onChunkLoaded?.(cx, cy);
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

  // Day-cycle scalar (task 310). The server ships
  // `time_of_day_seconds` on every TickUpdate so a freshly arrived
  // client doesn't have to wait for a state change. Forward it to the
  // renderer through the optional sink — tests / headless paths leave
  // the sink absent and the value is silently dropped.
  const daylight = deps.daylightSink;
  if (daylight?.onTimeOfDay) {
    const raw = tick.timeOfDaySeconds;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      daylight.onTimeOfDay(raw);
    }
  }

  // Per-tick effects feed (task 070): block edits one-shot, targeting
  // states are an authoritative replace. Both are scoped to this client's
  // view window server-side, so the bridge fans them out as-is.
  const effects = deps.effectsSink;
  if (effects) {
    if (effects.onBlockEdit) {
      for (const wire of tick.edits ?? []) {
        const event = blockEditFromWire(wire);
        if (event) effects.onBlockEdit(event);
      }
    }
    if (effects.applyTargets) {
      const targets: WireTargetingStateEvent[] = [];
      for (const wire of tick.targets ?? []) {
        const t = targetingStateFromWire(wire);
        if (t) targets.push(t);
      }
      effects.applyTargets(targets);
    }
  }
}

function blockEditFromWire(
  wire: anarchy.v1.IBlockEdit,
): WireBlockEditEvent | null {
  const coord = wire.chunkCoord;
  if (!coord) return null;
  const kind = blockEditKindFromWire(wire.kind);
  if (kind === null) return null;
  return {
    playerId: toNumber(wire.playerId),
    kind,
    cx: coord.cx ?? 0,
    cy: coord.cy ?? 0,
    lx: wire.localX ?? 0,
    ly: wire.localY ?? 0,
    blockType: blockTypeFromWire(wire.blockType),
  };
}

function blockEditKindFromWire(
  kind: anarchy.v1.BlockEdit.Kind | null | undefined,
): WireBlockEditKind | null {
  switch (kind) {
    case anarchy.v1.BlockEdit.Kind.BLOCK_EDIT_KIND_PLACED:
      return "placed";
    case anarchy.v1.BlockEdit.Kind.BLOCK_EDIT_KIND_BROKEN:
      return "broken";
    default:
      return null;
  }
}

function targetingStateFromWire(
  wire: anarchy.v1.ITargetingState,
): WireTargetingStateEvent | null {
  const coord = wire.chunkCoord;
  if (!coord) return null;
  return {
    playerId: toNumber(wire.playerId),
    cx: coord.cx ?? 0,
    cy: coord.cy ?? 0,
    lx: wire.localX ?? 0,
    ly: wire.localY ?? 0,
    durabilityPct: wire.durabilityPct ?? 0,
  };
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
    // Proto3 default for unset `uint32` is `0`. The server never ships a
    // live player at 0 HP (the kill pipeline respawns them at full before
    // the snapshot ships), so we treat the wire `0` as "missing field —
    // older server pre-task 060" and fall back to MAX_PLAYER_HEALTH.
    const wireHealth = p.health ?? 0;
    players.set(id, {
      id,
      x: p.x ?? 0,
      y: p.y ?? 0,
      facing: facingFromWire(p.facing),
      username: p.username ?? "",
      colorIndex: p.colorIndex ?? 0,
      equippedUtility: itemIdFromWire(p.equippedUtility),
      openChests: openChestsFromWire(p.openChests),
      health: wireHealth === 0 ? MAX_PLAYER_HEALTH : wireHealth,
    });
  }
  const entities = new Map<EntityId, Entity>();
  for (const e of wire.entities ?? []) {
    const kind = entityKindFromWire(e.kind);
    if (kind === null) continue;
    const id = toNumber(e.id);
    // Same proto3 default treatment as players above — a 0-HP entity is
    // dropped server-side before its chunk ships, so wire `0` means
    // "older server, no health field".
    const entHealth = e.health ?? 0;
    entities.set(id, {
      id,
      kind,
      tileX: e.tileX ?? 0,
      tileY: e.tileY ?? 0,
      health: entHealth === 0 ? maxHealthForKind(kind) : entHealth,
    });
  }
  return [[cx, cy] as const, { ground, top, players, entities }];
}

function entityKindFromWire(
  kind: anarchy.v1.EntityKind | null | undefined,
): EntityKind | null {
  switch (kind) {
    case anarchy.v1.EntityKind.ENTITY_KIND_SPIDER:
      return EntityKind.Spider;
    default:
      return null;
  }
}

function openChestsFromWire(
  wire: readonly anarchy.v1.IChestLocation[] | null | undefined,
): readonly OpenChestRef[] {
  if (!wire || wire.length === 0) return [];
  const out: OpenChestRef[] = [];
  for (const loc of wire) {
    const coord = loc.chunkCoord;
    if (!coord) continue;
    const lx = loc.localX ?? 0;
    const ly = loc.localY ?? 0;
    if (lx >= LAYER_SIZE || ly >= LAYER_SIZE) continue;
    out.push({ cx: coord.cx ?? 0, cy: coord.cy ?? 0, lx, ly });
  }
  return out;
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
