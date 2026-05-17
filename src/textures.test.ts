import { describe, expect, it } from "vitest";

import { BlockType, ItemId } from "./game/index.js";
import { ITEM_REGISTRY } from "./item_names.js";
import {
  BLOCK_REGISTRY,
  isSolidTopBlock,
  textureUrlForBlock,
  textureUrlForItem,
} from "./textures.js";

describe("BLOCK_REGISTRY", () => {
  it("carries a BlockMeta entry for every BlockType variant", () => {
    // Adding a `BlockType` variant must come with a `BLOCK_REGISTRY` entry —
    // the registry is the runtime source of truth for client-side block
    // metadata. Iterate the enum's numeric values and confirm each has an
    // entry whose `kind` field matches the lookup key.
    for (const value of Object.values(BlockType)) {
      if (typeof value !== "number") continue;
      const entry = BLOCK_REGISTRY[value as BlockType];
      expect(entry, `missing BLOCK_REGISTRY entry for kind ${value}`).toBeDefined();
      expect(entry.kind).toBe(value);
    }
  });

  it("textureUrlForBlock returns the registry's textureUrl", () => {
    for (const meta of Object.values(BLOCK_REGISTRY)) {
      expect(textureUrlForBlock(meta.kind)).toBe(meta.textureUrl);
    }
  });
});

describe("textureUrlForBlock", () => {
  it("returns a URL under /textures/blocks/ for every visible block kind", () => {
    for (const kind of [
      BlockType.Grass,
      BlockType.Wood,
      BlockType.Stone,
      BlockType.Gold,
      BlockType.Tree,
      BlockType.Sticks,
    ]) {
      const url = textureUrlForBlock(kind);
      expect(url).not.toBeNull();
      expect(url!).toMatch(/^\/textures\/blocks\/.+\.png$/);
    }
  });

  it("returns null for Air (no texture)", () => {
    expect(textureUrlForBlock(BlockType.Air)).toBeNull();
  });

  it("each visible kind has a distinct URL", () => {
    const seen = new Set<string>();
    for (const meta of Object.values(BLOCK_REGISTRY)) {
      if (meta.textureUrl === null) continue;
      expect(seen.has(meta.textureUrl)).toBe(false);
      seen.add(meta.textureUrl);
    }
  });
});

describe("isSolidTopBlock", () => {
  it("returns false for the walk-through decoratives (task 510 signal)", () => {
    // The break-anim layer uses `!isSolidTopBlock(kind)` to decide whether
    // to scale down the shatter + puff for small / walkable top blocks.
    // Locking the set down so a future ADR can't silently drop a kind into
    // the softer-feedback bucket without an explicit registry change.
    for (const kind of [
      BlockType.Sticks,
      BlockType.FlowerRed,
      BlockType.FlowerYellow,
      BlockType.FlowerBlue,
      BlockType.FlowerWhite,
      BlockType.Bush,
      BlockType.Torch,
    ]) {
      expect(isSolidTopBlock(kind)).toBe(false);
    }
  });

  it("returns true for full-cell solids, Tree, and Chest", () => {
    for (const kind of [
      BlockType.Grass,
      BlockType.Wood,
      BlockType.Stone,
      BlockType.Gold,
      BlockType.Tree,
      BlockType.Dirt,
      BlockType.Sand,
      BlockType.Gravel,
      BlockType.StoneLight,
      BlockType.StoneDark,
      BlockType.CopperOre,
      BlockType.IronOre,
      BlockType.TungstenOre,
      BlockType.CoalOre,
      BlockType.DiamondOre,
      BlockType.Chest,
    ]) {
      expect(isSolidTopBlock(kind)).toBe(true);
    }
  });
});

describe("textureUrlForItem", () => {
  it("Stick → sticks texture (item-name → block-name divergence)", () => {
    expect(textureUrlForItem(ItemId.Stick)).toBe(
      textureUrlForBlock(BlockType.Sticks),
    );
  });

  it("Wood / Stone / Gold use their matching block textures", () => {
    expect(textureUrlForItem(ItemId.Wood)).toBe(textureUrlForBlock(BlockType.Wood));
    expect(textureUrlForItem(ItemId.Stone)).toBe(textureUrlForBlock(BlockType.Stone));
    expect(textureUrlForItem(ItemId.Gold)).toBe(textureUrlForBlock(BlockType.Gold));
  });

  it("returns a URL for every defined ItemId", () => {
    for (const item of [
      ItemId.Stick,
      ItemId.Wood,
      ItemId.Stone,
      ItemId.Gold,
      ItemId.WoodPickaxe,
      ItemId.StonePickaxe,
      ItemId.CopperPickaxe,
      ItemId.IronPickaxe,
      ItemId.TungstenPickaxe,
      ItemId.WoodAxe,
      ItemId.StoneAxe,
      ItemId.CopperAxe,
      ItemId.IronAxe,
      ItemId.TungstenAxe,
    ]) {
      expect(textureUrlForItem(item)).not.toBeNull();
    }
  });

  it("VenomSack resolves to the gray-fallback path (task 180)", () => {
    // Task 180 ships the item without a dedicated icon. The inventory grid
    // paints a gray placeholder when `textureUrlForItem` returns null —
    // assert that contract here so a future change doesn't quietly wire a
    // missing PNG and break the cell.
    expect(textureUrlForItem(ItemId.VenomSack)).toBeNull();
  });

  it("registry entry textureUrl agrees with textureUrlForItem", () => {
    // Each `ItemMeta.textureUrl` must agree with the public `textureUrlForItem`
    // facade. Catches drift between the registry table and any future
    // per-item override path.
    for (const meta of Object.values(ITEM_REGISTRY)) {
      expect(textureUrlForItem(meta.id)).toBe(meta.textureUrl);
    }
  });

  it("each tool resolves to a distinct /textures/items/ URL", () => {
    const tools = [
      ItemId.WoodPickaxe,
      ItemId.StonePickaxe,
      ItemId.CopperPickaxe,
      ItemId.IronPickaxe,
      ItemId.TungstenPickaxe,
      ItemId.WoodAxe,
      ItemId.StoneAxe,
      ItemId.CopperAxe,
      ItemId.IronAxe,
      ItemId.TungstenAxe,
    ];
    const seen = new Set<string>();
    for (const item of tools) {
      const url = textureUrlForItem(item);
      expect(url).not.toBeNull();
      expect(url!).toMatch(/^\/textures\/items\/.+\.png$/);
      expect(seen.has(url!)).toBe(false);
      seen.add(url!);
    }
  });
});
