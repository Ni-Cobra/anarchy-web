import { describe, expect, it } from "vitest";

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  MAIN_SLOTS,
  type Slot,
} from "./inventory.js";

describe("Inventory", () => {
  it("starts with every slot empty", () => {
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      expect(inv.slot(i)).toBeNull();
    }
    expect(inv.allSlots()).toHaveLength(INVENTORY_SIZE);
  });

  it("exposes the hotbar / main split as a 9 + 36 = 45 layout", () => {
    expect(HOTBAR_SLOTS).toBe(9);
    expect(MAIN_SLOTS).toBe(36);
    expect(INVENTORY_SIZE).toBe(45);
  });

  it("returns null for out-of-range slot indices", () => {
    const inv = new Inventory();
    expect(inv.slot(-1)).toBeNull();
    expect(inv.slot(INVENTORY_SIZE)).toBeNull();
    expect(inv.slot(9999)).toBeNull();
  });

  it("counts items by kind across slots", () => {
    const inv = new Inventory();
    const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    slots[0] = { item: ItemId.Gold, count: 7 };
    slots[5] = { item: ItemId.Gold, count: 3 };
    slots[10] = { item: ItemId.Stone, count: 12 };
    inv.replaceFromWire(slots);
    expect(inv.countOf(ItemId.Gold)).toBe(10);
    expect(inv.countOf(ItemId.Stone)).toBe(12);
    expect(inv.countOf(ItemId.Stick)).toBe(0);
  });

  it("replaceFromWire mirrors the supplied slot array", () => {
    const inv = new Inventory();
    const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    slots[0] = { item: ItemId.Gold, count: 10 };
    inv.replaceFromWire(slots);
    expect(inv.slot(0)).toEqual({ item: ItemId.Gold, count: 10 });
    expect(inv.slot(1)).toBeNull();
  });

  it("replaceFromWire is a snapshot — later mutations to the source array don't leak", () => {
    const inv = new Inventory();
    const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    slots[0] = { item: ItemId.Wood, count: 1 };
    inv.replaceFromWire(slots);
    slots[0] = { item: ItemId.Gold, count: 99 };
    expect(inv.slot(0)).toEqual({ item: ItemId.Wood, count: 1 });
  });

  it("rejects a slot array of the wrong length", () => {
    const inv = new Inventory();
    expect(() => inv.replaceFromWire([])).toThrow();
    expect(() => inv.replaceFromWire(new Array(INVENTORY_SIZE - 1).fill(null))).toThrow();
    expect(() => inv.replaceFromWire(new Array(INVENTORY_SIZE + 1).fill(null))).toThrow();
  });
});
