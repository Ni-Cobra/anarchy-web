/**
 * Faction-leaderboard mirror (task 240, ADR 0008).
 *
 * Server ships a full snapshot once on welcome
 * (`ServerWelcome.initial_factions`) and a per-tick delta on every
 * `TickUpdate.factions_delta` thereafter. This store keeps the rolling
 * cached table, lets subscribers (currently the leaderboard HUD) drive
 * off the same data, and computes the "currently leading faction"
 * predicate locally without a wire round-trip.
 *
 * Network-free; pure data + math. The wire bridge in `net/` is the only
 * caller that pushes data in via `applySnapshot` / `applyDelta`.
 * Subscribers receive the latest snapshot synchronously when they
 * `subscribe` (if any has been applied) so the HUD's first paint
 * doesn't need a special-case "wait for the first apply" gate.
 */

import type { ChunkCoord } from "./terrain.js";

/** Globally unique faction id allocated by the server (monotonic u64). */
export type FactionId = number;

export interface FactionEntry {
  readonly id: FactionId;
  readonly name: string;
  readonly xp: number;
  /** World-space chunk coords of the bound flag. */
  readonly flagChunk: ChunkCoord;
  /** Local cell `(x, y)` of the bound flag inside `flagChunk`. */
  readonly flagLocal: readonly [number, number];
  /**
   * Color index of the founding flag (from the placing stack's frozen
   * `extra.flag.color_index`). Surfaced so the HUD can paint a colored
   * chip beside the faction name.
   */
  readonly colorIndex: number;
}

export type LeaderboardListener = (
  factions: ReadonlyMap<FactionId, FactionEntry>,
) => void;

/**
 * Result of `leaderTie(factions)`: the highest-xp entry, tiebroken by
 * lowest id. `null` when the map is empty.
 */
export function currentLeader(
  factions: ReadonlyMap<FactionId, FactionEntry>,
): FactionEntry | null {
  let best: FactionEntry | null = null;
  for (const f of factions.values()) {
    if (best === null) {
      best = f;
      continue;
    }
    if (f.xp > best.xp || (f.xp === best.xp && f.id < best.id)) {
      best = f;
    }
  }
  return best;
}

/**
 * Sort `factions` by xp descending, ties broken by id ascending. Returns
 * a fresh array — the original map iteration order is unspecified. Used
 * by the leaderboard HUD to render the hover dropdown.
 */
export function sortedByXpDesc(
  factions: ReadonlyMap<FactionId, FactionEntry>,
): FactionEntry[] {
  const arr = Array.from(factions.values());
  arr.sort((a, b) => {
    if (b.xp !== a.xp) return b.xp - a.xp;
    return a.id - b.id;
  });
  return arr;
}

export class LeaderboardStore {
  private readonly factions = new Map<FactionId, FactionEntry>();
  private readonly listeners = new Set<LeaderboardListener>();
  private hasInitial = false;

  /**
   * Replace the entire cached table from a server-shipped snapshot
   * (`ServerWelcome.initial_factions`). Called once per session.
   */
  applySnapshot(entries: readonly FactionEntry[]): void {
    this.factions.clear();
    for (const e of entries) this.factions.set(e.id, e);
    this.hasInitial = true;
    this.notify();
  }

  /**
   * Apply a `FactionsDelta`: every entry in `upserts` replaces the
   * cached entry (create + mutate share this path); every id in
   * `removed` retires the cached entry. The empty-delta case (the
   * common case) is a no-op except for the first `applyDelta` call,
   * which marks the store as ready so subscribers can paint.
   */
  applyDelta(
    upserts: readonly FactionEntry[],
    removed: readonly FactionId[],
  ): void {
    for (const e of upserts) this.factions.set(e.id, e);
    for (const id of removed) this.factions.delete(id);
    this.hasInitial = true;
    this.notify();
  }

  current(): ReadonlyMap<FactionId, FactionEntry> {
    return this.factions;
  }

  /**
   * Subscribe to leaderboard changes. Returns an unsubscribe fn. If a
   * snapshot has already been applied, the listener is invoked
   * synchronously once with the current cached table so the caller
   * paints without an initial "no data yet" branch.
   */
  subscribe(fn: LeaderboardListener): () => void {
    this.listeners.add(fn);
    if (this.hasInitial) fn(this.factions);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.factions);
  }
}
