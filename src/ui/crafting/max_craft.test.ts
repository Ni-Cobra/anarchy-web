// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  type Slot,
} from "../../game/index.js";
import { recipeById } from "../../recipes.js";
import { maxCraftCount } from "./max_craft.js";

function emptySlots(updates: Record<number, Slot> = {}): Slot[] {
  const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
  for (const [idx, slot] of Object.entries(updates)) {
    slots[Number(idx)] = slot;
  }
  return slots;
}

function inv(updates: Record<number, Slot> = {}): Inventory {
  const i = new Inventory();
  i.replaceFromWire(emptySlots(updates));
  return i;
}

describe("maxCraftCount", () => {
  const sticks = recipeById("sticks")!;
  const woodPickaxe = recipeById("wood-pickaxe")!;

  it("returns floor(have/need) for a single-ingredient recipe", () => {
    expect(maxCraftCount(sticks, inv({ 0: { item: ItemId.Wood, count: 5 } }))).toBe(
      5,
    );
  });

  it("returns 0 when nothing in the pool matches", () => {
    expect(maxCraftCount(sticks, inv())).toBe(0);
  });

  it("takes the min across multi-ingredient recipes", () => {
    // Task 580: wood-pickaxe consumes 3 Log + 2 Stick per craft. 6 Log ⇒ 2;
    // 3 Stick ⇒ 1. min = 1.
    expect(
      maxCraftCount(
        woodPickaxe,
        inv({
          0: { item: ItemId.Log, count: 6 },
          [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 3 },
        }),
      ),
    ).toBe(1);
  });

  it("pools counts across multiple Inventory arguments", () => {
    // Player has all the Logs, chest has all the Sticks — together they
    // can craft 2 wood-pickaxes (6 Log ⇒ 2; 5 Stick ⇒ 2).
    const player = inv({ 0: { item: ItemId.Log, count: 6 } });
    const chest = inv({ 0: { item: ItemId.Stick, count: 5 } });
    expect(maxCraftCount(woodPickaxe, player, chest)).toBe(2);
  });

  it("sums same-item counts across pools (chest tops up the player)", () => {
    // Player has 1 Stick, chest has 4 Sticks; with 9 Log the bottleneck
    // is Stick: (1 + 4) / 2 = 2 crafts.
    const player = inv({
      0: { item: ItemId.Log, count: 9 },
      [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 1 },
    });
    const chest = inv({ 0: { item: ItemId.Stick, count: 4 } });
    expect(maxCraftCount(woodPickaxe, player, chest)).toBe(2);
  });

  it("returns 0 for a recipe with no pools", () => {
    expect(maxCraftCount(sticks)).toBe(0);
  });
});
