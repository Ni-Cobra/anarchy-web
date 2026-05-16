import { describe, expect, it } from "vitest";

import { ItemId } from "./game/index.js";
import { recipeById, RECIPES } from "./recipes.js";

describe("recipes", () => {
  it("RECIPES table mirrors the server table — ids and shapes lockstep", () => {
    // Drift here is the most likely cross-boundary regression: the
    // ingredient/output integers must agree byte-for-byte with the
    // server's `RECIPES` table in `crafting.rs`. Pin every recipe so a
    // typo in either repo trips this assertion.
    expect(RECIPES).toEqual([
      {
        id: "sticks",
        ingredients: [{ item: ItemId.Wood, count: 1 }],
        output: { item: ItemId.Stick, count: 4 },
      },
      {
        id: "wood-from-log",
        ingredients: [{ item: ItemId.Log, count: 1 }],
        output: { item: ItemId.Wood, count: 1 },
      },
      {
        id: "sticks-from-log",
        ingredients: [{ item: ItemId.Log, count: 1 }],
        output: { item: ItemId.Stick, count: 4 },
      },
      {
        id: "wood-pickaxe",
        ingredients: [
          { item: ItemId.Log, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.WoodPickaxe, count: 1 },
      },
      {
        id: "wood-axe",
        ingredients: [
          { item: ItemId.Wood, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.WoodAxe, count: 1 },
      },
      {
        id: "stone-pickaxe",
        ingredients: [
          { item: ItemId.Stone, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.StonePickaxe, count: 1 },
      },
      {
        id: "stone-axe",
        ingredients: [
          { item: ItemId.Stone, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.StoneAxe, count: 1 },
      },
      {
        id: "copper-ingot",
        ingredients: [{ item: ItemId.RawCopper, count: 1 }],
        output: { item: ItemId.CopperIngot, count: 1 },
      },
      {
        id: "iron-ingot",
        ingredients: [{ item: ItemId.RawIron, count: 1 }],
        output: { item: ItemId.IronIngot, count: 1 },
      },
      {
        id: "tungsten-ingot",
        ingredients: [{ item: ItemId.RawTungsten, count: 1 }],
        output: { item: ItemId.TungstenIngot, count: 1 },
      },
      {
        id: "copper-pickaxe",
        ingredients: [
          { item: ItemId.CopperIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.CopperPickaxe, count: 1 },
      },
      {
        id: "copper-axe",
        ingredients: [
          { item: ItemId.CopperIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.CopperAxe, count: 1 },
      },
      {
        id: "iron-pickaxe",
        ingredients: [
          { item: ItemId.IronIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.IronPickaxe, count: 1 },
      },
      {
        id: "iron-axe",
        ingredients: [
          { item: ItemId.IronIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.IronAxe, count: 1 },
      },
      {
        id: "tungsten-pickaxe",
        ingredients: [
          { item: ItemId.TungstenIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.TungstenPickaxe, count: 1 },
      },
      {
        id: "tungsten-axe",
        ingredients: [
          { item: ItemId.TungstenIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.TungstenAxe, count: 1 },
      },
      {
        id: "torch",
        ingredients: [
          { item: ItemId.Stick, count: 1 },
          { item: ItemId.Coal, count: 1 },
        ],
        output: { item: ItemId.Torch, count: 4 },
      },
      {
        id: "lantern",
        ingredients: [
          { item: ItemId.Torch, count: 1 },
          { item: ItemId.IronIngot, count: 1 },
        ],
        output: { item: ItemId.Lantern, count: 1 },
      },
      {
        id: "chest",
        ingredients: [{ item: ItemId.Wood, count: 8 }],
        output: { item: ItemId.Chest, count: 1 },
      },
      {
        id: "wood-shovel",
        ingredients: [
          { item: ItemId.Log, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.WoodShovel, count: 1 },
      },
      {
        id: "stone-shovel",
        ingredients: [
          { item: ItemId.Stone, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.StoneShovel, count: 1 },
      },
      {
        id: "copper-shovel",
        ingredients: [
          { item: ItemId.CopperIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.CopperShovel, count: 1 },
      },
      {
        id: "iron-shovel",
        ingredients: [
          { item: ItemId.IronIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.IronShovel, count: 1 },
      },
      {
        id: "tungsten-shovel",
        ingredients: [
          { item: ItemId.TungstenIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.TungstenShovel, count: 1 },
      },
      {
        id: "wood-sword",
        ingredients: [
          { item: ItemId.Log, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.WoodSword, count: 1 },
      },
      {
        id: "stone-sword",
        ingredients: [
          { item: ItemId.Stone, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.StoneSword, count: 1 },
      },
      {
        id: "copper-sword",
        ingredients: [
          { item: ItemId.CopperIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.CopperSword, count: 1 },
      },
      {
        id: "iron-sword",
        ingredients: [
          { item: ItemId.IronIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.IronSword, count: 1 },
      },
      {
        id: "tungsten-sword",
        ingredients: [
          { item: ItemId.TungstenIngot, count: 3 },
          { item: ItemId.Stick, count: 2 },
        ],
        output: { item: ItemId.TungstenSword, count: 1 },
      },
    ]);
  });

  it("recipeById resolves known ids, returns undefined for unknown ones", () => {
    expect(recipeById("sticks")?.output.item).toBe(ItemId.Stick);
    expect(recipeById("wood-pickaxe")?.output.item).toBe(ItemId.WoodPickaxe);
    expect(recipeById("future-platinum-pickaxe")).toBeUndefined();
    expect(recipeById("")).toBeUndefined();
  });
});
