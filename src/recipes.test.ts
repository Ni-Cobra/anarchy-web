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
        id: "wood-pickaxe",
        ingredients: [
          { item: ItemId.Wood, count: 3 },
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
    ]);
  });

  it("recipeById resolves known ids, returns undefined for unknown ones", () => {
    expect(recipeById("sticks")?.output.item).toBe(ItemId.Stick);
    expect(recipeById("wood-pickaxe")?.output.item).toBe(ItemId.WoodPickaxe);
    expect(recipeById("future-platinum-pickaxe")).toBeUndefined();
    expect(recipeById("")).toBeUndefined();
  });
});
