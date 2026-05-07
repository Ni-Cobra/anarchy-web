/**
 * Block-texture path map. Single source of truth for which file each
 * `BlockType` is rendered as — both the world renderer and the inventory
 * UI consume this. Lives at the top of `src/` (alongside `lobby.ts`,
 * `config.ts`) precisely because it straddles `render/` and `ui/`: keeping
 * the path strings out of `render/` means UI code can import them without
 * pulling `three` into its bundle.
 *
 * Texture bytes are produced by `anarchy-server/dev_utils textures` and
 * checked into `public/textures/blocks/<kind>.png`. Vite serves the
 * `public/` tree at the URL paths returned here.
 */

import { BlockType, ItemId } from "./game/index.js";

/**
 * URL of the 16×16 PNG for each visible block kind. `Air` deliberately has
 * no entry — there's no texture for "no block", and the renderer's per-kind
 * branches all guard against `Air` before reaching the texture lookup.
 */
export const BLOCK_TEXTURE_URLS: Partial<Record<BlockType, string>> = {
  [BlockType.Grass]: "/textures/blocks/grass.png",
  [BlockType.Stone]: "/textures/blocks/stone.png",
  [BlockType.Wood]: "/textures/blocks/wood.png",
  [BlockType.Gold]: "/textures/blocks/gold.png",
  [BlockType.Tree]: "/textures/blocks/tree.png",
  [BlockType.Sticks]: "/textures/blocks/sticks.png",
};

/**
 * Texture URL for a `BlockType`, or `null` if the kind has no rendered
 * texture (today: only `Air`).
 */
export function textureUrlForBlock(kind: BlockType): string | null {
  return BLOCK_TEXTURE_URLS[kind] ?? null;
}

/**
 * URL of the 16×16 PNG for each task-090 tool item. Sourced from
 * `public/textures/items/<material>-<tool>.png` — produced by the same
 * `anarchy-server dev_utils textures` pipeline that generates the block
 * textures, so a re-skin is one edit per silhouette + a re-run of the
 * script.
 */
const TOOL_TEXTURE_URLS: Partial<Record<ItemId, string>> = {
  [ItemId.WoodPickaxe]: "/textures/items/wood-pickaxe.png",
  [ItemId.StonePickaxe]: "/textures/items/stone-pickaxe.png",
  [ItemId.CopperPickaxe]: "/textures/items/copper-pickaxe.png",
  [ItemId.IronPickaxe]: "/textures/items/iron-pickaxe.png",
  [ItemId.TungstenPickaxe]: "/textures/items/tungsten-pickaxe.png",
  [ItemId.WoodAxe]: "/textures/items/wood-axe.png",
  [ItemId.StoneAxe]: "/textures/items/stone-axe.png",
  [ItemId.CopperAxe]: "/textures/items/copper-axe.png",
  [ItemId.IronAxe]: "/textures/items/iron-axe.png",
  [ItemId.TungstenAxe]: "/textures/items/tungsten-axe.png",
};

/**
 * Texture URL for an inventory `ItemId`. Items that place a block share
 * that block's texture; tools use their own dedicated icon under
 * `/textures/items/`; consumables (none yet) would slot into the same
 * tool table or return `null`. Mirrors the `places_block` mapping in the
 * server's item registry — keep in lockstep when adding items.
 */
export function textureUrlForItem(item: ItemId): string | null {
  switch (item) {
    case ItemId.Stick:
      return BLOCK_TEXTURE_URLS[BlockType.Sticks] ?? null;
    case ItemId.Wood:
      return BLOCK_TEXTURE_URLS[BlockType.Wood] ?? null;
    case ItemId.Stone:
      return BLOCK_TEXTURE_URLS[BlockType.Stone] ?? null;
    case ItemId.Gold:
      return BLOCK_TEXTURE_URLS[BlockType.Gold] ?? null;
    case ItemId.WoodPickaxe:
    case ItemId.StonePickaxe:
    case ItemId.CopperPickaxe:
    case ItemId.IronPickaxe:
    case ItemId.TungstenPickaxe:
    case ItemId.WoodAxe:
    case ItemId.StoneAxe:
    case ItemId.CopperAxe:
    case ItemId.IronAxe:
    case ItemId.TungstenAxe:
      return TOOL_TEXTURE_URLS[item] ?? null;
  }
  return null;
}
