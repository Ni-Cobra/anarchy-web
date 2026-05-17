/**
 * Top-level dispatcher for the wire bridge: route a decoded
 * `ServerMessage` to the per-message-kind handler that owns its
 * translation. Per-handler logic (and the small types they own) lives in
 * `wire_tick.ts` (steady-state per-tick state-sync) and
 * `wire_inventory.ts` (local-player inventory updates). Shared decode
 * primitives live in `wire_codec.ts`. This file owns only the dispatcher
 * itself, the deps object every handler shares, and the local-player id
 * sink — anything specific to a single message kind belongs in its
 * sibling, not here.
 *
 * This is the only place protobuf types touch `World` / `SnapshotBuffer`
 * / `Terrain` / `LocalPlayerSink` (transitively via the per-handler
 * modules).
 */
import { anarchy } from "../gen/anarchy.js";
import {
  type ChunkCoord,
  type Inventory,
  type PlayerId,
  type SnapshotBuffer,
  type Terrain,
  type World,
} from "../game/index.js";

import { applyChestUpdate, type ChestSink } from "./wire_chest.js";
import { toNumber } from "./wire_codec.js";
import { applyInventoryUpdate } from "./wire_inventory.js";
import {
  applyTickUpdate,
  type DaylightSink,
  type EffectsSink,
  type TerrainSink,
  type WireAttackEvent,
  type WireAttackOutcome,
  type WireBlockEditEvent,
  type WireBlockEditKind,
  type WireDamageEvent,
  type WireDeathEvent,
  type WireTargetKind,
  type WireTargetingStateEvent,
} from "./wire_tick.js";

export type {
  DaylightSink,
  EffectsSink,
  TerrainSink,
  WireAttackEvent,
  WireAttackOutcome,
  WireBlockEditEvent,
  WireBlockEditKind,
  WireDamageEvent,
  WireDeathEvent,
  WireTargetKind,
  WireTargetingStateEvent,
};

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
   * Renderer effects-layer hooks; see `EffectsSink`. Optional — tests
   * that don't exercise the per-tick block-edit / targeting feed leave
   * it absent and the bridge silently drops the events.
   */
  readonly effectsSink?: EffectsSink;
  /**
   * Renderer day-cycle hook; see `DaylightSink`. Optional — tests / wire-
   * level specs that don't exercise rendering leave it absent and the
   * bridge silently drops the synced `time_of_day_seconds` scalar.
   */
  readonly daylightSink?: DaylightSink;
  /**
   * Local-player inventory mirror. Mutated in place when `InventoryUpdate`
   * arrives. Per-player only — the server never ships another player's
   * inventory, so this is always the local player's view. Optional for
   * tests that don't exercise inventory.
   */
  readonly inventory?: Inventory;
  /**
   * Task 420 open-chest mirror sink. Optional — tests that don't
   * exercise the chest UI leave it absent; production bootstrap mounts
   * a `ChestState` here so `ChestUpdate` frames feed the chest panel.
   */
  readonly chestSink?: ChestSink;
  /** Wall-clock for stamping samples. Override in tests. */
  readonly now?: () => number;
}

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

  if (msg.chestUpdate) {
    applyChestUpdate(msg.chestUpdate, deps.chestSink);
    return;
  }
}
