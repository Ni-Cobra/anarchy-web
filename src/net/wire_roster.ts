/**
 * `ConnectedPlayersList` handler (task 170). Decodes the wire roster
 * (`entries` + `max_players`) into the client's `Roster` shape and pushes
 * it into the `RosterStore` the HUD subscribes to.
 *
 * Two call sites:
 * - Standalone `ServerMessage.connected_players_list` broadcasts on
 *   join/leave (routed by `wire.ts`).
 * - `ServerWelcome.initial_roster` baked into the welcome — the welcome
 *   handler in `wire.ts` calls this helper directly so the HUD has data
 *   to paint before the first join/leave event arrives.
 */
import type { anarchy } from "../gen/anarchy.js";
import type { Roster, RosterEntry, RosterStore } from "../game/index.js";

import { toNumber } from "./wire_codec.js";

export function applyConnectedPlayersList(
  wire: anarchy.v1.IConnectedPlayersList,
  store: RosterStore | undefined,
): void {
  if (!store) return;
  store.apply(rosterFromWire(wire));
}

export function rosterFromWire(
  wire: anarchy.v1.IConnectedPlayersList,
): Roster {
  const wireEntries = wire.entries ?? [];
  const entries: RosterEntry[] = wireEntries.map((e) => ({
    playerId: toNumber(e.playerId),
    username: e.username ?? "",
  }));
  return { entries, maxPlayers: wire.maxPlayers ?? 0 };
}
