/**
 * Client-side mirror of the server's `ITEM_REGISTRY`
 * (see `anarchy-server/src/game/item/mod.rs`). One [`ItemMeta`] entry per
 * `ItemId` carrying the fields the client UI consumes (display name,
 * texture URL, places-a-block hint). Runtime behaviour (validation, drops,
 * crafting outcomes) still asks the server — this table is purely the
 * client's render-time lookup.
 *
 * Names are display-only — wire / mirror code uses the `ItemId` enum and
 * never these strings. Keep the table in lockstep with the server registry
 * whenever an item kind lands.
 */

import { BlockType, ItemId } from "./game/index.js";

/**
 * Per-item static data the client needs at render time. Mirrors
 * `ItemMetadata` on the server — only the rendering-relevant subset is
 * carried (display string, what block the item places, and the texture URL).
 */
export interface ItemMeta {
  readonly id: ItemId;
  readonly displayName: string;
  /** Block the item places when the player right-clicks. `null` for tools. */
  readonly placesBlock: BlockType | null;
  /** URL of the 64×64 PNG icon, or `null` if there's no rendered texture. */
  readonly textureUrl: string | null;
}

const BLOCK_TEXTURES_BASE = "/textures/blocks";
const ITEM_TEXTURES_BASE = "/textures/items";

/**
 * Single source of truth for per-`ItemId` static metadata on the client.
 * Keys are the `ItemId` numeric enum; the table covers every variant. Items
 * that place a block share that block's texture; tools have their own
 * dedicated icon under `/textures/items/<material>-<tool>.png`. Adding an
 * `ItemId` variant requires a matching entry here and on the server.
 */
export const ITEM_REGISTRY: Record<ItemId, ItemMeta> = {
  [ItemId.Stick]: {
    id: ItemId.Stick,
    displayName: "Stick",
    placesBlock: BlockType.Sticks,
    textureUrl: `${BLOCK_TEXTURES_BASE}/sticks.png`,
  },
  [ItemId.Wood]: {
    id: ItemId.Wood,
    displayName: "Wood",
    placesBlock: BlockType.Wood,
    textureUrl: `${BLOCK_TEXTURES_BASE}/wood.png`,
  },
  [ItemId.Stone]: {
    id: ItemId.Stone,
    displayName: "Stone",
    placesBlock: BlockType.Stone,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone.png`,
  },
  [ItemId.Gold]: {
    id: ItemId.Gold,
    displayName: "Gold",
    placesBlock: BlockType.Gold,
    textureUrl: `${BLOCK_TEXTURES_BASE}/gold.png`,
  },
  [ItemId.WoodPickaxe]: {
    id: ItemId.WoodPickaxe,
    displayName: "Wood Pickaxe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/wood-pickaxe.png`,
  },
  [ItemId.StonePickaxe]: {
    id: ItemId.StonePickaxe,
    displayName: "Stone Pickaxe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/stone-pickaxe.png`,
  },
  [ItemId.CopperPickaxe]: {
    id: ItemId.CopperPickaxe,
    displayName: "Copper Pickaxe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/copper-pickaxe.png`,
  },
  [ItemId.IronPickaxe]: {
    id: ItemId.IronPickaxe,
    displayName: "Iron Pickaxe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/iron-pickaxe.png`,
  },
  [ItemId.TungstenPickaxe]: {
    id: ItemId.TungstenPickaxe,
    displayName: "Tungsten Pickaxe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/tungsten-pickaxe.png`,
  },
  [ItemId.WoodAxe]: {
    id: ItemId.WoodAxe,
    displayName: "Wood Axe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/wood-axe.png`,
  },
  [ItemId.StoneAxe]: {
    id: ItemId.StoneAxe,
    displayName: "Stone Axe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/stone-axe.png`,
  },
  [ItemId.CopperAxe]: {
    id: ItemId.CopperAxe,
    displayName: "Copper Axe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/copper-axe.png`,
  },
  [ItemId.IronAxe]: {
    id: ItemId.IronAxe,
    displayName: "Iron Axe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/iron-axe.png`,
  },
  [ItemId.TungstenAxe]: {
    id: ItemId.TungstenAxe,
    displayName: "Tungsten Axe",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/tungsten-axe.png`,
  },
  [ItemId.FlowerRed]: {
    id: ItemId.FlowerRed,
    displayName: "Red Flower",
    placesBlock: BlockType.FlowerRed,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-red.png`,
  },
  [ItemId.FlowerYellow]: {
    id: ItemId.FlowerYellow,
    displayName: "Yellow Flower",
    placesBlock: BlockType.FlowerYellow,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-yellow.png`,
  },
  [ItemId.FlowerBlue]: {
    id: ItemId.FlowerBlue,
    displayName: "Blue Flower",
    placesBlock: BlockType.FlowerBlue,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-blue.png`,
  },
  [ItemId.FlowerWhite]: {
    id: ItemId.FlowerWhite,
    displayName: "White Flower",
    placesBlock: BlockType.FlowerWhite,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-white.png`,
  },
  [ItemId.Bush]: {
    id: ItemId.Bush,
    displayName: "Bush",
    placesBlock: BlockType.Bush,
    textureUrl: `${BLOCK_TEXTURES_BASE}/bush.png`,
  },
  [ItemId.Dirt]: {
    id: ItemId.Dirt,
    displayName: "Dirt",
    placesBlock: BlockType.Dirt,
    textureUrl: `${BLOCK_TEXTURES_BASE}/dirt.png`,
  },
  [ItemId.Sand]: {
    id: ItemId.Sand,
    displayName: "Sand",
    placesBlock: BlockType.Sand,
    textureUrl: `${BLOCK_TEXTURES_BASE}/sand.png`,
  },
  [ItemId.Gravel]: {
    id: ItemId.Gravel,
    displayName: "Gravel",
    placesBlock: BlockType.Gravel,
    textureUrl: `${BLOCK_TEXTURES_BASE}/gravel.png`,
  },
  [ItemId.StoneLight]: {
    id: ItemId.StoneLight,
    displayName: "Light Stone",
    placesBlock: BlockType.StoneLight,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone-light.png`,
  },
  [ItemId.StoneDark]: {
    id: ItemId.StoneDark,
    displayName: "Dark Stone",
    placesBlock: BlockType.StoneDark,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone-dark.png`,
  },
  [ItemId.RawCopper]: {
    id: ItemId.RawCopper,
    displayName: "Raw Copper",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/raw-copper.png`,
  },
  [ItemId.RawIron]: {
    id: ItemId.RawIron,
    displayName: "Raw Iron",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/raw-iron.png`,
  },
  [ItemId.RawTungsten]: {
    id: ItemId.RawTungsten,
    displayName: "Raw Tungsten",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/raw-tungsten.png`,
  },
  [ItemId.Coal]: {
    id: ItemId.Coal,
    displayName: "Coal",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/coal.png`,
  },
  [ItemId.Diamond]: {
    id: ItemId.Diamond,
    displayName: "Diamond",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/diamond.png`,
  },
  [ItemId.CopperIngot]: {
    id: ItemId.CopperIngot,
    displayName: "Copper Ingot",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/copper-ingot.png`,
  },
  [ItemId.IronIngot]: {
    id: ItemId.IronIngot,
    displayName: "Iron Ingot",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/iron-ingot.png`,
  },
  [ItemId.TungstenIngot]: {
    id: ItemId.TungstenIngot,
    displayName: "Tungsten Ingot",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/tungsten-ingot.png`,
  },
  [ItemId.Torch]: {
    id: ItemId.Torch,
    displayName: "Torch",
    placesBlock: BlockType.Torch,
    textureUrl: `${BLOCK_TEXTURES_BASE}/torch.png`,
  },
  [ItemId.Lantern]: {
    id: ItemId.Lantern,
    displayName: "Lantern",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/lantern.png`,
  },
  [ItemId.Log]: {
    id: ItemId.Log,
    displayName: "Log",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/log.png`,
  },
  [ItemId.Chest]: {
    id: ItemId.Chest,
    displayName: "Chest",
    placesBlock: BlockType.Chest,
    textureUrl: `${ITEM_TEXTURES_BASE}/chest.png`,
  },
  [ItemId.WoodShovel]: {
    id: ItemId.WoodShovel,
    displayName: "Wood Shovel",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/wood-shovel.png`,
  },
  [ItemId.StoneShovel]: {
    id: ItemId.StoneShovel,
    displayName: "Stone Shovel",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/stone-shovel.png`,
  },
  [ItemId.CopperShovel]: {
    id: ItemId.CopperShovel,
    displayName: "Copper Shovel",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/copper-shovel.png`,
  },
  [ItemId.IronShovel]: {
    id: ItemId.IronShovel,
    displayName: "Iron Shovel",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/iron-shovel.png`,
  },
  [ItemId.TungstenShovel]: {
    id: ItemId.TungstenShovel,
    displayName: "Tungsten Shovel",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/tungsten-shovel.png`,
  },
  [ItemId.Grass]: {
    id: ItemId.Grass,
    displayName: "Grass",
    placesBlock: BlockType.Grass,
    textureUrl: `${BLOCK_TEXTURES_BASE}/grass.png`,
  },
  [ItemId.LightMushroom]: {
    id: ItemId.LightMushroom,
    displayName: "Light Mushroom",
    placesBlock: BlockType.LightMushroom,
    textureUrl: `${BLOCK_TEXTURES_BASE}/light-mushroom.png`,
  },
  [ItemId.WoodSword]: {
    id: ItemId.WoodSword,
    displayName: "Wood Sword",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/wood-sword.png`,
  },
  [ItemId.StoneSword]: {
    id: ItemId.StoneSword,
    displayName: "Stone Sword",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/stone-sword.png`,
  },
  [ItemId.CopperSword]: {
    id: ItemId.CopperSword,
    displayName: "Copper Sword",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/copper-sword.png`,
  },
  [ItemId.IronSword]: {
    id: ItemId.IronSword,
    displayName: "Iron Sword",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/iron-sword.png`,
  },
  [ItemId.TungstenSword]: {
    id: ItemId.TungstenSword,
    displayName: "Tungsten Sword",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/tungsten-sword.png`,
  },
  [ItemId.String]: {
    id: ItemId.String,
    displayName: "String",
    placesBlock: null,
    textureUrl: `${ITEM_TEXTURES_BASE}/string.png`,
  },
  // Task 180 — spider death drop, raw input for the poison-dart recipe
  // (task 190). No dedicated icon yet; falls back to the inventory grid's
  // gray placeholder until a polish pass lands one under /textures/items/.
  [ItemId.VenomSack]: {
    id: ItemId.VenomSack,
    displayName: "Venom Sack",
    placesBlock: null,
    textureUrl: null,
  },
};

/**
 * Human-readable name for an `ItemId`. Falls back to a generic
 * `Unknown item` for ids not yet listed — preferable to throwing during a
 * UI render in the rare case the wire ships an item ahead of a UI rebuild.
 */
export function itemDisplayName(item: ItemId): string {
  return ITEM_REGISTRY[item]?.displayName ?? "Unknown item";
}
