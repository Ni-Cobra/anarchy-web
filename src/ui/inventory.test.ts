// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  type Slot,
} from "../game/index.js";
import { mountInventoryUi } from "./inventory.js";

function fillSlots(updates: Record<number, Slot>): Slot[] {
  const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
  for (const [idx, slot] of Object.entries(updates)) {
    slots[Number(idx)] = slot;
  }
  return slots;
}

describe("inventory UI", () => {
  let inventory: Inventory;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    inventory = new Inventory();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("renders an empty inventory: 9 hotbar cells, 36 panel cells, panel hidden", () => {
    const ui = mountInventoryUi({ getInventory: () => inventory });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const panelCells = document.querySelectorAll(
      ".anarchy-inventory-panel .anarchy-inventory-slot",
    );
    expect(hotbarCells).toHaveLength(HOTBAR_SLOTS);
    expect(panelCells).toHaveLength(INVENTORY_SIZE - HOTBAR_SLOTS);

    const icons = document.querySelectorAll(".anarchy-inventory-icon");
    expect(icons).toHaveLength(0);

    const panel = document.querySelector(".anarchy-inventory-panel")!;
    expect(panel.classList.contains("open")).toBe(false);
    expect(ui.isOpen()).toBe(false);

    // Slot 0 carries the reserved selection highlight even when empty.
    expect(hotbarCells[0].classList.contains("selected")).toBe(true);
    for (let i = 1; i < HOTBAR_SLOTS; i++) {
      expect(hotbarCells[i].classList.contains("selected")).toBe(false);
    }
  });

  it("renders 10 gold in slot 0 with a count badge", () => {
    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    mountInventoryUi({ getInventory: () => inventory });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const slot0 = hotbarCells[0];
    const icon = slot0.querySelector(".anarchy-inventory-icon");
    expect(icon).not.toBeNull();
    const count = slot0.querySelector(".anarchy-inventory-count");
    expect(count?.textContent).toBe("10");

    // Other hotbar slots are empty.
    for (let i = 1; i < HOTBAR_SLOTS; i++) {
      expect(hotbarCells[i].querySelector(".anarchy-inventory-icon")).toBeNull();
    }
  });

  it("renders mixed kinds across the hotbar and main grid", () => {
    inventory.replaceFromWire(
      fillSlots({
        0: { item: ItemId.Gold, count: 10 },
        2: { item: ItemId.Stone, count: 1 }, // count 1 → no badge
        5: { item: ItemId.Wood, count: 64 },
        // Main slot — addressed flat at HOTBAR_SLOTS + n.
        [HOTBAR_SLOTS + 0]: { item: ItemId.Stick, count: 3 },
        [HOTBAR_SLOTS + 7]: { item: ItemId.Gold, count: 999 },
      }),
    );
    mountInventoryUi({ getInventory: () => inventory });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const panelCells = document.querySelectorAll(
      ".anarchy-inventory-panel .anarchy-inventory-slot",
    );

    expect(
      hotbarCells[0].querySelector(".anarchy-inventory-count")?.textContent,
    ).toBe("10");
    // count===1 omits the badge.
    expect(
      hotbarCells[2].querySelector(".anarchy-inventory-count"),
    ).toBeNull();
    expect(
      hotbarCells[2].querySelector(".anarchy-inventory-icon"),
    ).not.toBeNull();
    expect(
      hotbarCells[5].querySelector(".anarchy-inventory-count")?.textContent,
    ).toBe("64");

    expect(
      panelCells[0].querySelector(".anarchy-inventory-icon"),
    ).not.toBeNull();
    expect(
      panelCells[0].querySelector(".anarchy-inventory-count")?.textContent,
    ).toBe("3");
    expect(
      panelCells[7].querySelector(".anarchy-inventory-count")?.textContent,
    ).toBe("999");

    // Untouched slots stay empty.
    expect(panelCells[3].querySelector(".anarchy-inventory-icon")).toBeNull();
  });

  it("re-renders reactively when the inventory mutates", () => {
    mountInventoryUi({ getInventory: () => inventory });

    // Empty → no icons.
    let icons = document.querySelectorAll(".anarchy-inventory-icon");
    expect(icons).toHaveLength(0);

    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    icons = document.querySelectorAll(".anarchy-inventory-icon");
    expect(icons).toHaveLength(1);

    inventory.replaceFromWire(
      fillSlots({
        0: { item: ItemId.Gold, count: 9 },
        1: { item: ItemId.Stone, count: 1 },
      }),
    );
    icons = document.querySelectorAll(".anarchy-inventory-icon");
    expect(icons).toHaveLength(2);
    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    expect(
      hotbarCells[0].querySelector(".anarchy-inventory-count")?.textContent,
    ).toBe("9");
  });

  it("toggles the side panel open / closed", () => {
    const ui = mountInventoryUi({ getInventory: () => inventory });
    const panel = document.querySelector(".anarchy-inventory-panel")!;

    expect(ui.isOpen()).toBe(false);
    expect(panel.classList.contains("open")).toBe(false);

    ui.toggle();
    expect(ui.isOpen()).toBe(true);
    expect(panel.classList.contains("open")).toBe(true);

    ui.setOpen(false);
    expect(ui.isOpen()).toBe(false);
    expect(panel.classList.contains("open")).toBe(false);
  });

  it("unmount removes the root and stops reactive updates", () => {
    const ui = mountInventoryUi({ getInventory: () => inventory });
    expect(document.querySelector("#anarchy-inventory-root")).not.toBeNull();

    ui.unmount();
    expect(document.querySelector("#anarchy-inventory-root")).toBeNull();

    // After unmount, mutations don't throw or leak DOM back.
    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    expect(document.querySelector("#anarchy-inventory-root")).toBeNull();
  });

  it("stops mousedown / contextmenu inside the overlay from reaching window", () => {
    mountInventoryUi({ getInventory: () => inventory });

    let windowHits = 0;
    const onWindow = (): void => {
      windowHits++;
    };
    window.addEventListener("mousedown", onWindow);
    window.addEventListener("contextmenu", onWindow);

    const hotbar = document.querySelector(".anarchy-hotbar")! as HTMLElement;
    hotbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    hotbar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const panel = document.querySelector(
      ".anarchy-inventory-panel",
    )! as HTMLElement;
    panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(windowHits).toBe(0);

    // Sanity: a click on document.body still reaches window — the stop is
    // scoped to the overlay roots, not global.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(windowHits).toBe(1);

    window.removeEventListener("mousedown", onWindow);
    window.removeEventListener("contextmenu", onWindow);
  });
});
