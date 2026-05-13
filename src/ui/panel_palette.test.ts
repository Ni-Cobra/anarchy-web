// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChestState,
  type ChestLocation,
  INVENTORY_SIZE,
  Inventory,
  type Slot,
} from "../game/index.js";
import { mountChestUi } from "./chest/index.js";
import { mountInventoryUi } from "./inventory/index.js";
import {
  CELL_BACKGROUND,
  CELL_BORDER_COLOR,
  CELL_HOVER_BORDER_COLOR,
  PANEL_BACKGROUND,
} from "./panel_palette.js";

const CHEST_LOC: ChestLocation = { cx: 0, cy: 0, lx: 0, ly: 0 };

function mountBothPanels(): void {
  const emptySlots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
  const playerInv = new Inventory();
  playerInv.replaceFromWire(emptySlots);
  const chestState = new ChestState();
  chestState.replaceFromWire(CHEST_LOC, emptySlots);
  const inventoryUi = mountInventoryUi({
    getInventory: () => playerInv,
    getChestInventory: (key) => chestState.inventoryForKey(key),
    sendSelect: () => {},
    sendMove: () => {},
    sendEquip: () => {},
    sendUnequip: () => {},
  });
  mountChestUi({
    chestState,
    inventoryUi,
    sendCloseChest: () => {},
  });
}

function styleText(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

describe("panel_palette token consumption (task 600)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("both panels' injected stylesheets reference the shared palette tokens", () => {
    mountBothPanels();
    const inventoryStyle = styleText("anarchy-inventory-style");
    const chestStyle = styleText("anarchy-chest-style");

    for (const css of [inventoryStyle, chestStyle]) {
      expect(css).not.toBe("");
      expect(css).toContain(PANEL_BACKGROUND);
      expect(css).toContain(CELL_BACKGROUND);
      expect(css).toContain(CELL_BORDER_COLOR);
      expect(css).toContain(CELL_HOVER_BORDER_COLOR);
    }
  });
});
