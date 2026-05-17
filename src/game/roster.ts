/**
 * Connected-player roster mirror (task 170). Server ships a
 * `ConnectedPlayersList` once on welcome (via `ServerWelcome.initial_roster`)
 * and again on every join/leave; this store is a tiny reactive cache the
 * player-list HUD subscribes to.
 *
 * Network-free; the wire bridge in `net/` is the only caller that pushes
 * snapshots in via `apply`. Subscribers receive the latest snapshot
 * synchronously when they `subscribe` (if any has been applied) so the
 * HUD's first paint doesn't need a special-case "wait for the first
 * apply" gate.
 */
import type { PlayerId } from "./player.js";

export interface RosterEntry {
  readonly playerId: PlayerId;
  readonly username: string;
}

export interface Roster {
  /** Sorted ascending by `playerId` — the server already pins this. */
  readonly entries: readonly RosterEntry[];
  /** Hard cap from the server's `config::MAX_PLAYERS`. */
  readonly maxPlayers: number;
}

export type RosterListener = (roster: Roster) => void;

export class RosterStore {
  private latest: Roster | null = null;
  private readonly listeners = new Set<RosterListener>();

  apply(roster: Roster): void {
    this.latest = roster;
    for (const fn of this.listeners) fn(roster);
  }

  current(): Roster | null {
    return this.latest;
  }

  /**
   * Subscribe to roster updates. Returns an unsubscribe fn. If a roster
   * has already been applied, the listener is invoked synchronously
   * once with the current snapshot so the caller can paint without an
   * initial "no data yet" branch.
   */
  subscribe(fn: RosterListener): () => void {
    this.listeners.add(fn);
    if (this.latest !== null) fn(this.latest);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
