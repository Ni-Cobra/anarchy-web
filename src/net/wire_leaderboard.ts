/**
 * Faction-leaderboard wire bridge (task 240, ADR 0008).
 *
 * The server ships two adjacent shapes:
 * - `FactionsSnapshot` on `ServerWelcome.initial_factions` — full
 *   registry replacement, run once on admit.
 * - `FactionsDelta` on every `TickUpdate.factions_delta` — `upserts`
 *   + `removed` lists. Empty in the common case.
 *
 * This module owns the two decoders + the `applyFactionsSnapshot` /
 * `applyFactionsDelta` entry points the wire dispatcher calls. The
 * `LeaderboardStore` is the only consumer; if a deps object doesn't
 * carry one, both entry points silently no-op (tests that don't
 * exercise the leaderboard skip wiring it in).
 */
import type { anarchy } from "../gen/anarchy.js";
import type { FactionEntry, LeaderboardStore } from "../game/index.js";

import { toNumber } from "./wire_codec.js";

export function factionFromWire(
  wire: anarchy.v1.IFactionSnapshot,
): FactionEntry {
  const chunk = wire.flagChunk ?? { cx: 0, cy: 0 };
  return {
    id: toNumber(wire.id),
    name: wire.name ?? "",
    xp: toNumber(wire.xp),
    flagChunk: [chunk.cx ?? 0, chunk.cy ?? 0],
    flagLocal: [wire.flagLocalX ?? 0, wire.flagLocalY ?? 0],
    colorIndex: wire.colorIndex ?? 0,
  };
}

export function applyFactionsSnapshot(
  wire: anarchy.v1.IFactionsSnapshot,
  store: LeaderboardStore | undefined,
): void {
  if (!store) return;
  const entries = (wire.factions ?? []).map(factionFromWire);
  store.applySnapshot(entries);
}

export function applyFactionsDelta(
  wire: anarchy.v1.IFactionsDelta | null | undefined,
  store: LeaderboardStore | undefined,
): void {
  if (!store) return;
  if (!wire) return;
  const upserts = (wire.upserts ?? []).map(factionFromWire);
  const removed = (wire.removed ?? []).map(toNumber);
  // Skip the notify storm for an empty delta — the common case once
  // the registry has stabilized. The leaderboard HUD only re-renders
  // on a real change.
  if (upserts.length === 0 && removed.length === 0) return;
  store.applyDelta(upserts, removed);
}
