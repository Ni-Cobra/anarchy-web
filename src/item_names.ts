/**
 * Single source of truth for human-readable `ItemId` names. Lives at the top
 * of `src/` (alongside `textures.ts`) because it straddles surfaces:
 * inventory tooltips today, equipment slots / hotbar callouts / future
 * crafting UI tomorrow. Keeping the strings in one place avoids drift when a
 * new item kind lands.
 *
 * Names are display-only — wire / mirror code uses the `ItemId` enum and
 * never these strings.
 */

import { ItemId } from "./game/index.js";

const ITEM_DISPLAY_NAMES: Record<ItemId, string> = {
  [ItemId.Stick]: "Stick",
  [ItemId.Wood]: "Wood",
  [ItemId.Stone]: "Stone",
  [ItemId.Gold]: "Gold",
  [ItemId.WoodPickaxe]: "Wood Pickaxe",
  [ItemId.StonePickaxe]: "Stone Pickaxe",
  [ItemId.CopperPickaxe]: "Copper Pickaxe",
  [ItemId.IronPickaxe]: "Iron Pickaxe",
  [ItemId.TungstenPickaxe]: "Tungsten Pickaxe",
  [ItemId.WoodAxe]: "Wood Axe",
  [ItemId.StoneAxe]: "Stone Axe",
  [ItemId.CopperAxe]: "Copper Axe",
  [ItemId.IronAxe]: "Iron Axe",
  [ItemId.TungstenAxe]: "Tungsten Axe",
};

/**
 * Human-readable name for an `ItemId`. Falls back to a generic
 * `Unknown item` for ids not yet listed — preferable to throwing during a
 * UI render in the rare case the wire ships an item ahead of a UI rebuild.
 */
export function itemDisplayName(item: ItemId): string {
  return ITEM_DISPLAY_NAMES[item] ?? "Unknown item";
}
