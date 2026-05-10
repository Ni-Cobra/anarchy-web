/**
 * Material tier of a tool item. Mirrors the server's `ToolTier` enum
 * (see `anarchy-server/src/game/item/mod.rs`).
 *
 * Variants are ordered ascending by progression — the numeric ordering
 * matches the server's derived `Ord` so a comparison `a >= b` reads
 * "tier `a` is at or above tier `b`". The client uses this to drive the
 * mining-gate hint and to read off the equipped pickaxe's tier; the
 * server remains authoritative for whether a break / place actually
 * succeeds.
 */

export enum ToolTier {
  Wood = 0,
  Stone = 1,
  Copper = 2,
  Iron = 3,
  Tungsten = 4,
}

/** Display string for a `ToolTier` — used by the client tier-gate hint. */
export function toolTierDisplayName(tier: ToolTier): string {
  switch (tier) {
    case ToolTier.Wood:
      return "Wood";
    case ToolTier.Stone:
      return "Stone";
    case ToolTier.Copper:
      return "Copper";
    case ToolTier.Iron:
      return "Iron";
    case ToolTier.Tungsten:
      return "Tungsten";
  }
}
