import { anarchy } from "../gen/anarchy.js";
import type {
  LocalPredictor,
  Player,
  PlayerId,
  SnapshotBuffer,
  World,
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
