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
  /**
   * Whether a top-layer block of this kind blocks player movement.
   * Mirrors `BlockMeta::is_solid_top` on the server — `false` for the
   * walk-through decoratives (`Sticks`, flowers, `Bush`, `Torch`),
   * `true` for full-cell solids and `Tree` / `Chest`. Renderer-only on
   * the client: drives the softer break animation for non-solid top
   * cells (task 510). `Air` and the wire-only `Hidden` sentinel are
   * `false`; neither is ever a real break target.
   */
  readonly isSolidTop: boolean;
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
    isSolidTop: false,
  },
  [BlockType.Grass]: {
    kind: BlockType.Grass,
    textureUrl: `${BLOCK_TEXTURES_BASE}/grass.png`,
    displayName: "Grass",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Wood]: {
    kind: BlockType.Wood,
    textureUrl: `${BLOCK_TEXTURES_BASE}/wood.png`,
    displayName: "Wood",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Stone]: {
    kind: BlockType.Stone,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone.png`,
    displayName: "Stone",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Gold]: {
    kind: BlockType.Gold,
    textureUrl: `${BLOCK_TEXTURES_BASE}/gold.png`,
    displayName: "Gold",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Tree]: {
    kind: BlockType.Tree,
    textureUrl: `${BLOCK_TEXTURES_BASE}/tree.png`,
    displayName: "Tree",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Sticks]: {
    kind: BlockType.Sticks,
    textureUrl: `${BLOCK_TEXTURES_BASE}/sticks.png`,
    displayName: "Sticks",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.Hidden]: {
    kind: BlockType.Hidden,
    textureUrl: null,
    displayName: "Hidden",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.FlowerRed]: {
    kind: BlockType.FlowerRed,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-red.png`,
    displayName: "Red Flower",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.FlowerYellow]: {
    kind: BlockType.FlowerYellow,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-yellow.png`,
    displayName: "Yellow Flower",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.FlowerBlue]: {
    kind: BlockType.FlowerBlue,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-blue.png`,
    displayName: "Blue Flower",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.FlowerWhite]: {
    kind: BlockType.FlowerWhite,
    textureUrl: `${BLOCK_TEXTURES_BASE}/flower-white.png`,
    displayName: "White Flower",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.Bush]: {
    kind: BlockType.Bush,
    textureUrl: `${BLOCK_TEXTURES_BASE}/bush.png`,
    displayName: "Bush",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.Dirt]: {
    kind: BlockType.Dirt,
    textureUrl: `${BLOCK_TEXTURES_BASE}/dirt.png`,
    displayName: "Dirt",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Sand]: {
    kind: BlockType.Sand,
    textureUrl: `${BLOCK_TEXTURES_BASE}/sand.png`,
    displayName: "Sand",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Gravel]: {
    kind: BlockType.Gravel,
    textureUrl: `${BLOCK_TEXTURES_BASE}/gravel.png`,
    displayName: "Gravel",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.StoneLight]: {
    kind: BlockType.StoneLight,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone-light.png`,
    displayName: "Light Stone",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.StoneDark]: {
    kind: BlockType.StoneDark,
    textureUrl: `${BLOCK_TEXTURES_BASE}/stone-dark.png`,
    displayName: "Dark Stone",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.CopperOre]: {
    kind: BlockType.CopperOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/copper-ore.png`,
    displayName: "Copper Ore",
    minToolTier: ToolTier.Stone,
    isSolidTop: true,
  },
  [BlockType.IronOre]: {
    kind: BlockType.IronOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/iron-ore.png`,
    displayName: "Iron Ore",
    minToolTier: ToolTier.Copper,
    isSolidTop: true,
  },
  [BlockType.TungstenOre]: {
    kind: BlockType.TungstenOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/tungsten-ore.png`,
    displayName: "Tungsten Ore",
    minToolTier: ToolTier.Iron,
    isSolidTop: true,
  },
  [BlockType.CoalOre]: {
    kind: BlockType.CoalOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/coal-ore.png`,
    displayName: "Coal Ore",
    minToolTier: ToolTier.Wood,
    isSolidTop: true,
  },
  [BlockType.DiamondOre]: {
    kind: BlockType.DiamondOre,
    textureUrl: `${BLOCK_TEXTURES_BASE}/diamond-ore.png`,
    displayName: "Diamond Ore",
    minToolTier: ToolTier.Iron,
    isSolidTop: true,
  },
  [BlockType.Torch]: {
    kind: BlockType.Torch,
    textureUrl: `${BLOCK_TEXTURES_BASE}/torch.png`,
    displayName: "Torch",
    minToolTier: null,
    isSolidTop: false,
  },
  [BlockType.Chest]: {
    kind: BlockType.Chest,
    textureUrl: `${BLOCK_TEXTURES_BASE}/chest.png`,
    displayName: "Chest",
    minToolTier: null,
    isSolidTop: true,
  },
  [BlockType.Tombstone]: {
    kind: BlockType.Tombstone,
    textureUrl: `${BLOCK_TEXTURES_BASE}/tombstone.png`,
    displayName: "Tombstone",
    minToolTier: null,
    isSolidTop: true,
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
 * Whether a top-layer block of this kind blocks player movement. Mirrors
 * the server's `BlockType::is_solid_top`. Renderer-only consumer today:
 * the break animation scales down for non-solid-top kinds (task 510).
 * Unknown kinds default to `true` — being conservative here means a
 * surprise variant still gets the full "real block broke" feedback
 * rather than a silently muted puff.
 */
export function isSolidTopBlock(kind: BlockType): boolean {
  return BLOCK_REGISTRY[kind]?.isSolidTop ?? true;
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
