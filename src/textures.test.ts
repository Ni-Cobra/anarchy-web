import { describe, expect, it } from "vitest";

import { BlockType, ItemId } from "./game/index.js";
import { ITEM_REGISTRY } from "./item_names.js";
import {
  BLOCK_REGISTRY,
  BLOCK_TEXTURE_URLS,
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
    for (const url of Object.values(BLOCK_TEXTURE_URLS)) {
      if (!url) continue;
      expect(seen.has(url)).toBe(false);
      seen.add(url);
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
