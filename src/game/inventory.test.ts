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

  it("replaceFromWire replaces, never merges — prior non-empty slots clear when the new frame is empty", () => {
    // First frame seeds a busy mid-session state (two non-empty slots).
    const inv = new Inventory();
    const seeded: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    seeded[0] = { item: ItemId.Gold, count: 10 };
    seeded[5] = { item: ItemId.Stone, count: 20 };
    inv.replaceFromWire(seeded);
    expect(inv.slot(0)).toEqual({ item: ItemId.Gold, count: 10 });
    expect(inv.slot(5)).toEqual({ item: ItemId.Stone, count: 20 });

    // A second frame with a different layout (slot 0 empty, slot 7 carrying
    // Wood, slot 5 still missing) must wholesale replace the mirror — no
    // merge fallback that would keep the prior Gold/Stone alive.
    const next: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    next[7] = { item: ItemId.Wood, count: 3 };
    inv.replaceFromWire(next);
    expect(inv.slot(0)).toBeNull();
    expect(inv.slot(5)).toBeNull();
    expect(inv.slot(7)).toEqual({ item: ItemId.Wood, count: 3 });
    expect(inv.countOf(ItemId.Gold)).toBe(0);
    expect(inv.countOf(ItemId.Stone)).toBe(0);
  });

  it("subscribe fires on every replaceFromWire and the unsubscribe stops further notifications", () => {
    const inv = new Inventory();
    let calls = 0;
    const unsubscribe = inv.subscribe(() => {
      calls++;
    });

    const empty: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    inv.replaceFromWire(empty);
    expect(calls).toBe(1);

    const seeded: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    seeded[0] = { item: ItemId.Gold, count: 1 };
    inv.replaceFromWire(seeded);
    expect(calls).toBe(2);

    unsubscribe();
    inv.replaceFromWire(empty);
    expect(calls).toBe(2);
  });
});
