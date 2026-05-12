/**
 * Stringly id for a chest location. Used by the multi-chest mirror in
 * [`./chest_state`] as a hashable Map key, and by the panel manager +
 * cross-grid drag/drop machinery in the UI layer for the same reason.
 * The format is `"cx,cy,lx,ly"` — round-trippable through
 * `chestLocationFromKey` so wire-frame senders can reconstruct the
 * `ChestLocation` at send time.
 */

import type { ChestLocation } from "./chest_state.js";

export type ChestKey = string;

export function chestKeyOf(loc: ChestLocation): ChestKey {
  return `${loc.cx},${loc.cy},${loc.lx},${loc.ly}`;
}

export function chestLocationFromKey(key: ChestKey): ChestLocation {
  const parts = key.split(",");
  return {
    cx: Number(parts[0]),
    cy: Number(parts[1]),
    lx: Number(parts[2]),
    ly: Number(parts[3]),
  };
}
