import { anarchy } from "../gen/anarchy.js";
import type { Player, PlayerId, SnapshotBuffer, World } from "../game/index.js";

/**
 * Whatever the renderer needs from the wire layer beyond raw world state.
 * Today that's only "tell me which player id is the local one"; the wire
 * layer holds onto this hook so the renderer stays networking-agnostic.
 */
export interface LocalPlayerSink {
  setLocalPlayerId(id: PlayerId | null): void;
}

export interface WireDeps {
  readonly world: World;
  readonly buffer: SnapshotBuffer;
  readonly local: LocalPlayerSink;
  /** Wall-clock for stamping samples. Override in tests. */
  readonly now?: () => number;
}

/**
 * Translate one decoded `ServerMessage` into mutations on the game-state
 * mirror. This is the only place protobuf types touch `World` /
 * `SnapshotBuffer` / `LocalPlayerSink`.
 *
 * Per ADR 0001 every tick carries a full `WorldSnapshot`, so:
 *   - `ServerWelcome.snapshot` and `StateUpdate.snapshot` both feed
 *     `World.applySnapshot` (a full replace) and append one sample per
 *     player to the per-id history in `SnapshotBuffer`.
 *   - `PlayerDespawned` removes the player from both stores immediately
 *     (the next tick wouldn't include them anyway, but acting on the
 *     explicit signal lets the cube vanish without waiting ~50 ms).
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
    deps.local.setLocalPlayerId(toNumber(w.playerId));
    if (w.snapshot) ingestSnapshot(w.snapshot, deps.world, deps.buffer, now());
    return;
  }

  if (msg.stateUpdate?.snapshot) {
    ingestSnapshot(msg.stateUpdate.snapshot, deps.world, deps.buffer, now());
    return;
  }

  if (msg.playerDespawned) {
    const id = toNumber(msg.playerDespawned.playerId);
    deps.world.removePlayer(id);
    deps.buffer.drop(id);
    return;
  }
}

function ingestSnapshot(
  snapshot: anarchy.v1.IWorldSnapshot,
  world: World,
  buffer: SnapshotBuffer,
  timeMs: number,
): void {
  const players: Player[] = (snapshot.players ?? []).map((p) => ({
    id: toNumber(p.id),
    x: p.x ?? 0,
    y: p.y ?? 0,
  }));
  world.applySnapshot(players);
  for (const p of players) {
    buffer.push(p.id, p.x, p.y, timeMs);
  }
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
