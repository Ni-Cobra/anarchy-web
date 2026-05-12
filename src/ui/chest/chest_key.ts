/**
 * Stringly id for a chest location (task 591). Used by the panel manager
 * and the cross-grid drag/drop machinery as a hashable Map key. The
 * format is `"cx,cy,lx,ly"` — round-trippable through
 * `chestLocationFromKey` so the wire-frame senders in `bootstrap/actions.ts`
 * can reconstruct the `ChestLocation` at send time.
 */

import type { ChestLocation } from "../../game/index.js";

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
