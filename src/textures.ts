/**
 * Block-texture path map. Single source of truth for which file each
 * `BlockType` is rendered as — both the world renderer and the inventory
 * UI consume this.
 *
 * This file owns the client-side mirror of the server's `BLOCK_REGISTRY`
 * (see `anarchy-server/src/game/terrain/block.rs`): one [`BlockMeta`] entry
 * per `BlockType` keyed by the enum, with the texture path derived from the
 * server's `texture_name` basename. `textureUrlForBlock` and
 * `textureUrlForItem` are thin facades over this registry — keep the
 * registry table in lockstep with the server's whenever a kind lands.
 *
 * Texture bytes are produced by `anarchy-server/dev_utils textures` and
 * checked into `public/textures/blocks/<kind>.png`. Vite serves the
 * `public/` tree at the URL paths returned here.
 */

import { BlockType, ItemId } from "./game/index.js";
import { ITEM_REGISTRY } from "./item_names.js";
import { ToolTier } from "./tool_tier.js";

/**
 * Per-kind static data the renderer / UI needs about a block. Mirrors
 * `BlockMeta` on the server; carries only the fields the client uses
 * (rendered texture URL today, display name for future tooltips,
 * minimum-pickaxe tier for the mining gate hint).
 */
export interface BlockMeta {
  readonly kind: BlockType;
  /** URL of the 64×64 PNG, or `null` for kinds with no rendered texture. */
  readonly textureUrl: string | null;
  /** Tooltip / billboard string. */
  readonly displayName: string;
  /**
   * Minimum equipped pickaxe tier required to break this block, or `null`
   * for blocks with no minimum (every kind today except the ores). The
   * client uses this to grey out the hover indicator with a hint when the
   * player can't mine the targeted ore — server is authoritative; this is
   * purely an affordance.
   */
  readonly minToolTier: ToolTier | null;
}

const BLOCK_TEXTURES_BASE = "/textures/blocks";

/**
 * Single source of truth for per-`BlockType` static metadata on the client.
 * Keyed by `BlockType` (numeric enum) — accessing a missing variant returns
 * `undefined`, but [`textureUrlForBlock`] guards against that. Adding a
 * `BlockType` variant requires a matching entry here and on the server.
 *
 * `Air` and `Hidden` carry `textureUrl: null` — neither has a renderable
 * face. Wire-occlusion sentinel `Hidden` (task 060) stays in the registry
 * because the renderer's per-kind branches still consult the metadata for
 * naming.
 */
export const BLOCK_REGISTRY: Record<BlockType, BlockMeta> = {
  [BlockType.Air]: {
    kind: BlockType.Air,
    textureUrl: null,
    displayName: "Air",
    minToolTier: null,
  },
  [BlockType.Grass]: {
    kind: BlockType.Grass,
    textureUrl: `${BLOCK_TEXTURES_BASE}/grass.png`,
    displayName: "Grass",
    minToolTier: null,
  },
  [BlockType.Wood]: {
    kind: BlockType.Wood,
    textureUrl: `${BLOCK_TEXTURES_BASE}/wood.png`,
    displayName: "Wood",
    minToolTier: null,
  },
  [BlockType.Stone]: {
    kind: BlockType.Stone,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone.png`,
    displayName: "Stone",
    minToolTier: null,
  },
  [BlockType.Gold]: {
    kind: BlockType.Gold,
    textureUrl: `${BLOCK_TEXTURES_BASE}/gold.png`,
    displayName: "Gold",
    minToolTier: null,
  },
  [BlockType.Tree]: {
    kind: BlockType.Tree,
    textureUrl: `${BLOCK_TEXTURES_BASE}/tree.png`,
    displayName: "Tree",
    minToolTier: null,
  },
  [BlockType.Sticks]: {
    kind: BlockType.Sticks,
    textureUrl: `${BLOCK_TEXTURES_BASE}/sticks.png`,
    displayName: "Sticks",
    minToolTier: null,
  },
  [BlockType.Hidden]: {
    kind: BlockType.Hidden,
    textureUrl: null,
    displayName: "Hidden",
    minToolTier: null,
  },
  [BlockType.FlowerRed]: {
    kind: BlockType.FlowerRed,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-red.png`,
    displayName: "Red Flower",
    minToolTier: null,
  },
  [BlockType.FlowerYellow]: {
    kind: BlockType.FlowerYellow,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-yellow.png`,
    displayName: "Yellow Flower",
    minToolTier: null,
  },
  [BlockType.FlowerBlue]: {
    kind: BlockType.FlowerBlue,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-blue.png`,
    displayName: "Blue Flower",
    minToolTier: null,
  },
  [BlockType.FlowerWhite]: {
    kind: BlockType.FlowerWhite,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-white.png`,
    displayName: "White Flower",
    minToolTier: null,
  },
  [BlockType.Bush]: {
    kind: BlockType.Bush,
    textureUrl: `${BLOCK_TEXTURES_BASE}/bush.png`,
    displayName: "Bush",
    minToolTier: null,
  },
  [BlockType.Dirt]: {
    kind: BlockType.Dirt,
    textureUrl: `${BLOCK_TEXTURES_BASE}/dirt.png`,
    displayName: "Dirt",
    minToolTier: null,
  },
  [BlockType.Sand]: {
    kind: BlockType.Sand,
    textureUrl: `${BLOCK_TEXTURES_BASE}/sand.png`,
    displayName: "Sand",
    minToolTier: null,
  },
  [BlockType.Gravel]: {
    kind: BlockType.Gravel,
    textureUrl: `${BLOCK_TEXTURES_BASE}/gravel.png`,
    displayName: "Gravel",
    minToolTier: null,
  },
  [BlockType.StoneLight]: {
    kind: BlockType.StoneLight,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone-light.png`,
    displayName: "Light Stone",
    minToolTier: null,
  },
  [BlockType.StoneDark]: {
    kind: BlockType.StoneDark,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone-dark.png`,
    displayName: "Dark Stone",
    minToolTier: null,
  },
  [BlockType.CopperOre]: {
    kind: BlockType.CopperOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/copper-ore.png`,
    displayName: "Copper Ore",
    minToolTier: ToolTier.Stone,
  },
  [BlockType.IronOre]: {
    kind: BlockType.IronOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/iron-ore.png`,
    displayName: "Iron Ore",
    minToolTier: ToolTier.Copper,
  },
  [BlockType.TungstenOre]: {
    kind: BlockType.TungstenOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/tungsten-ore.png`,
    displayName: "Tungsten Ore",
    minToolTier: ToolTier.Iron,
  },
  [BlockType.CoalOre]: {
    kind: BlockType.CoalOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/coal-ore.png`,
    displayName: "Coal Ore",
    minToolTier: ToolTier.Wood,
  },
  [BlockType.DiamondOre]: {
    kind: BlockType.DiamondOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/diamond-ore.png`,
    displayName: "Diamond Ore",
    minToolTier: ToolTier.Iron,
  },
};

/**
 * Texture URL for a `BlockType`, or `null` if the kind has no rendered
 * texture (today: `Air` and the `Hidden` occlusion sentinel).
 */
export function textureUrlForBlock(kind: BlockType): string | null {
  return BLOCK_REGISTRY[kind]?.textureUrl ?? null;
}

/**
 * Texture URL for an inventory `ItemId`. The `textureUrl` field on each
 * item-registry entry is the source of truth: items that place a block
 * point at that block's texture; tools point at their own dedicated icon
 * under `/textures/items/`.
 */
export function textureUrlForItem(item: ItemId): string | null {
  return ITEM_REGISTRY[item]?.textureUrl ?? null;
}
