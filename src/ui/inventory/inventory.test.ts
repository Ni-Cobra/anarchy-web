// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  type Slot,
} from "../../game/index.js";
import { mountInventoryUi } from "./index.js";
import { _resetTooltipForTests } from "../tooltip.js";

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
    _resetTooltipForTests();
    inventory = new Inventory();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  it("renders an empty inventory: 9 hotbar cells, 36 panel cells laid out 4 cols × 9 rows, panel hidden", () => {
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const panelCells = document.querySelectorAll(
      ".anarchy-inventory-panel .anarchy-inventory-slot",
    );
    expect(hotbarCells).toHaveLength(HOTBAR_SLOTS);
    expect(panelCells).toHaveLength(INVENTORY_SIZE - HOTBAR_SLOTS);

    // Panel grid is the transposed 4×9 layout (was 9×4). The CSS grid
    // template carries the column count, and 36 cells / 4 cols = 9 rows.
    const panel = document.querySelector(".anarchy-inventory-panel")! as HTMLElement;
    const styleEl = document.getElementById("anarchy-inventory-style")!;
    expect(styleEl.textContent).toContain("grid-template-columns: repeat(4, 48px)");

    const inventoryIcons = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-icon, .anarchy-inventory-panel .anarchy-inventory-icon",
    );
    expect(inventoryIcons).toHaveLength(0);

    expect(panel.classList.contains("open")).toBe(false);
    expect(ui.isOpen()).toBe(false);

    // Slot 0 carries the reserved selection highlight even when empty.
    expect(hotbarCells[0].classList.contains("selected")).toBe(true);
    for (let i = 1; i < HOTBAR_SLOTS; i++) {
      expect(hotbarCells[i].classList.contains("selected")).toBe(false);
    }
  });

  it("injects a :hover border-color rule for inventory cells (cursor-on-cell affordance)", () => {
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    const styleEl = document.getElementById("anarchy-inventory-style")!;
    // Compact-whitespace match so the assertion isn't tied to exact
    // formatting of the injected CSS string.
    const css = styleEl.textContent!.replace(/\s+/g, " ");
    expect(css).toMatch(/\.anarchy-inventory-slot:hover \{ border-color:/);
  });

  it("renders 10 gold in slot 0 with a count badge", () => {
    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

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
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

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

  it("renders task-090 tools with their own /textures/items/ icon URLs and a unit-count cell (no badge)", () => {
    // Pickaxe + axe in five tiers — the seed loadout layout puts them in
    // the lower half of the panel, but the renderer is layout-agnostic
    // (panel slot N → flat index HOTBAR_SLOTS + N), so just slot one of
    // each into a known grid cell and assert the icon URL + count badge.
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
    const updates: Record<number, Slot> = {};
    for (let i = 0; i < tools.length; i++) {
      updates[HOTBAR_SLOTS + i] = { item: tools[i], count: 1 };
    }
    inventory.replaceFromWire(fillSlots(updates));
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    const panelCells = document.querySelectorAll(
      ".anarchy-inventory-panel .anarchy-inventory-slot",
    );
    const seenUrls = new Set<string>();
    for (let i = 0; i < tools.length; i++) {
      const cell = panelCells[i] as HTMLElement;
      const icon = cell.querySelector<HTMLElement>(".anarchy-inventory-icon");
      expect(icon).not.toBeNull();
      const bg = icon!.style.backgroundImage;
      expect(bg).toMatch(/\/textures\/items\/.+\.png/);
      expect(seenUrls.has(bg)).toBe(false);
      seenUrls.add(bg);
      // count = 1 → no badge for tools (matches existing single-stack rule).
      expect(cell.querySelector(".anarchy-inventory-count")).toBeNull();
    }
  });

  it("re-renders reactively when the inventory mutates", () => {
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    // Scope to hotbar / panel — equipment slots paint their own
    // silhouette icons that aren't part of the inventory mutation under
    // test here.
    const inventoryIconSelector =
      ".anarchy-hotbar .anarchy-inventory-icon, .anarchy-inventory-panel .anarchy-inventory-icon";
    // Empty → no icons.
    let icons = document.querySelectorAll(inventoryIconSelector);
    expect(icons).toHaveLength(0);

    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    icons = document.querySelectorAll(inventoryIconSelector);
    expect(icons).toHaveLength(1);

    inventory.replaceFromWire(
      fillSlots({
        0: { item: ItemId.Gold, count: 9 },
        1: { item: ItemId.Stone, count: 1 },
      }),
    );
    icons = document.querySelectorAll(inventoryIconSelector);
    expect(icons).toHaveLength(2);
    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    expect(
      hotbarCells[0].querySelector(".anarchy-inventory-count")?.textContent,
    ).toBe("9");
  });

  it("toggles the side panel open / closed", () => {
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });
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
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    expect(document.querySelector("#anarchy-inventory-root")).not.toBeNull();

    ui.unmount();
    expect(document.querySelector("#anarchy-inventory-root")).toBeNull();

    // After unmount, mutations don't throw or leak DOM back.
    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    expect(document.querySelector("#anarchy-inventory-root")).toBeNull();
  });

  it("clicking a hotbar cell flips selection and ships a SelectSlot", () => {
    inventory.replaceFromWire(
      fillSlots({
        0: { item: ItemId.Gold, count: 10 },
        3: { item: ItemId.Stone, count: 4 },
      }),
    );
    const sent: number[] = [];
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: (slot) => sent.push(slot),
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    expect(ui.selectedHotbarSlot()).toBe(0);
    hotbarCells[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ui.selectedHotbarSlot()).toBe(3);
    expect(sent).toEqual([3]);
    expect(hotbarCells[0].classList.contains("selected")).toBe(false);
    expect(hotbarCells[3].classList.contains("selected")).toBe(true);

    // Clicking the already-selected cell is a no-op — no extra send.
    hotbarCells[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sent).toEqual([3]);
  });

  it("selectHotbarSlot updates the highlight and ships SelectSlot", () => {
    const sent: number[] = [];
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: (slot) => sent.push(slot),
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    expect(ui.selectedHotbarSlot()).toBe(0);
    ui.selectHotbarSlot(5);
    expect(ui.selectedHotbarSlot()).toBe(5);
    expect(sent).toEqual([5]);
    // Out-of-range slots are ignored.
    ui.selectHotbarSlot(HOTBAR_SLOTS);
    ui.selectHotbarSlot(-1);
    expect(sent).toEqual([5]);
  });

  it("dragging a non-empty slot onto another slot ships a MoveSlot", () => {
    inventory.replaceFromWire(
      fillSlots({
        0: { item: ItemId.Gold, count: 10 },
      }),
    );
    const moves: Array<[number, number]> = [];
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: (src, dst) => moves.push([src, dst]),
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const src = hotbarCells[0] as HTMLElement;
    const dst = hotbarCells[5] as HTMLElement;

    // Stub elementsFromPoint to return the destination cell — happy-dom
    // doesn't compute layout, so we can't rely on the real hit-test.
    const original = document.elementsFromPoint;
    document.elementsFromPoint = ((_x: number, _y: number) => [dst]) as typeof document.elementsFromPoint;

    src.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    // Cross the drag-promotion threshold so the pending gesture turns
    // into a drag rather than a click.
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 200,
        clientY: 200,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 200,
        clientY: 200,
        bubbles: true,
      }),
    );

    document.elementsFromPoint = original;
    expect(moves).toEqual([[0, 5]]);
  });

  it("dragging from an empty slot does not ship a MoveSlot", () => {
    const moves: Array<[number, number]> = [];
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: (src, dst) => moves.push([src, dst]),
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const src = hotbarCells[0] as HTMLElement;

    src.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 200,
        clientY: 200,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 200,
        clientY: 200,
        bubbles: true,
      }),
    );
    expect(moves).toEqual([]);
  });

  it("dragging onto the same slot is a no-op", () => {
    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    const moves: Array<[number, number]> = [];
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: (src, dst) => moves.push([src, dst]),
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const src = hotbarCells[0] as HTMLElement;
    const original = document.elementsFromPoint;
    document.elementsFromPoint = ((_x: number, _y: number) => [src]) as typeof document.elementsFromPoint;

    src.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    // Promote to a drag, then release back over the source.
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 50,
        clientY: 50,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    document.elementsFromPoint = original;
    expect(moves).toEqual([]);
  });

  it("escape during a drag cancels cleanly — no sendMove, preview removed, source highlight cleared", () => {
    inventory.replaceFromWire(
      fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
    );
    const moves: Array<[number, number]> = [];
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: (src, dst) => moves.push([src, dst]),
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );
    const src = hotbarCells[0] as HTMLElement;
    src.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    // Drag promotion happens on the first pointermove past the threshold.
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );
    expect(
      document.querySelector(".anarchy-inventory-drag-preview"),
    ).not.toBeNull();
    expect(src.classList.contains("drag-source")).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(
      document.querySelector(".anarchy-inventory-drag-preview"),
    ).toBeNull();
    expect(src.classList.contains("drag-source")).toBe(false);

    // A subsequent pointerup-on-target must NOT fire a MoveSlot — the drag
    // already aborted.
    const dst = hotbarCells[5] as HTMLElement;
    const original = document.elementsFromPoint;
    document.elementsFromPoint = ((_x: number, _y: number) => [dst]) as typeof document.elementsFromPoint;
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 200,
        clientY: 200,
        bubbles: true,
      }),
    );
    document.elementsFromPoint = original;
    expect(moves).toEqual([]);
  });

  describe("click-to-swap (panel → selected hotbar)", () => {
    // Helper: dispatch a "click" gesture on the cell — pointerdown
    // followed by an immediate pointerup at the same coords (no
    // pointermove past the threshold). Mirrors the user's "tap a panel
    // cell to drop it in the active hand" flow.
    function clickGesture(target: HTMLElement, x = 10, y = 10): void {
      target.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    }

    it("clicking a non-empty panel cell ships MoveSlot(panel → selectedHotbar) when the hotbar slot is empty", () => {
      // Selected hotbar slot is 0 (empty); panel slot 0 (= flat index
      // HOTBAR_SLOTS) holds Gold. Click → server gets the move and
      // (server-side) the stack relocates whole into the empty slot.
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 10 },
        }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);
    });

    it("clicking a same-kind panel cell into a same-kind hotbar slot ships MoveSlot — server merges", () => {
      // Both slots hold Gold. The wire is the same MoveSlot — the
      // merge / overflow split happens server-side via try_move_slot →
      // Inventory::merge_stacks.
      inventory.replaceFromWire(
        fillSlots({
          0: { item: ItemId.Gold, count: 10 },
          [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 60 },
        }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);
    });

    it("clicking a different-kind panel cell into a different-kind hotbar slot ships MoveSlot — server swaps", () => {
      inventory.replaceFromWire(
        fillSlots({
          0: { item: ItemId.Stone, count: 5 },
          [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 10 },
        }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);
    });

    it("clicking an empty panel cell with an empty hotbar slot is still a no-op (server would NOOP — skip the wire frame)", () => {
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([]);
    });

    it("clicking an empty panel cell with a populated hotbar ships MoveSlot(panel → selectedHotbar) — swap-with-air case", () => {
      // Hotbar slot 0 holds Gold; panel slot 0 is empty. Click on the
      // empty panel cell → server runs `swap_slots` (merge fails on empty
      // src) and the Gold relocates into the panel cell. Mirrors the
      // forward direction of the existing "non-empty panel + empty
      // hotbar" test.
      inventory.replaceFromWire(
        fillSlots({
          0: { item: ItemId.Gold, count: 10 },
        }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);
    });

    it("targets the *currently-selected* hotbar slot, not just slot 0", () => {
      // Move the selection to slot 4, then click a panel cell. The
      // wire MoveSlot must point at 4, not 0.
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 10 },
        }),
      );
      const moves: Array<[number, number]> = [];
      const ui = mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      ui.selectHotbarSlot(4);
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([[HOTBAR_SLOTS, 4]]);
    });

    it("a pointerdown+up on a hotbar cell does NOT ship MoveSlot — selection stays its own path", () => {
      // Hotbar cells own their own click-to-select handler (verified
      // separately by the "clicking a hotbar cell flips selection"
      // test). The panel click-swap path must not double-fire on a
      // hotbar pointerup that didn't promote into a drag.
      inventory.replaceFromWire(
        fillSlots({ 3: { item: ItemId.Stone, count: 4 } }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const hotbarCells = document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      );
      clickGesture(hotbarCells[3] as HTMLElement);
      expect(moves).toEqual([]);
    });

    it("a click followed by a drag distinguishes correctly: only the drag ships MoveSlot", () => {
      // Click on a panel cell first (one MoveSlot to the selected
      // hotbar). Then drag from the same panel cell to a hotbar slot
      // 5 (a second MoveSlot). The two gestures must produce two
      // distinct emissions, in order.
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 10 },
        }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      const hotbarCells = document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      );
      const panelCell = panelCells[0] as HTMLElement;
      const dst = hotbarCells[5] as HTMLElement;

      // Gesture #1: click. No pointermove past the threshold.
      clickGesture(panelCell, 10, 10);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);

      // Gesture #2: drag. Pointermove past the threshold turns it into
      // a drag; pointerup over slot 5 ships MoveSlot to 5, not 0.
      const original = document.elementsFromPoint;
      document.elementsFromPoint = ((_x: number, _y: number) => [
        dst,
      ]) as typeof document.elementsFromPoint;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.elementsFromPoint = original;
      expect(moves).toEqual([
        [HOTBAR_SLOTS, 0],
        [HOTBAR_SLOTS, 5],
      ]);
    });
  });

  it("escape outside an active drag is a no-op", () => {
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    // No drag in flight; escape must not throw or mutate DOM.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(
      document.querySelector(".anarchy-inventory-drag-preview"),
    ).toBeNull();
  });

  it("selectHotbarSlot cycles through every hotbar index, ratcheting selection and shipping each", () => {
    // Mirrors the bootstrap-level keyboard / wheel state machine: every
    // hotbar slot 0..HOTBAR_SLOTS-1 is selectable, the highlight class
    // tracks the current slot, and the `SelectSlot` action fires once per
    // distinct selection.
    const sent: number[] = [];
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: (slot) => sent.push(slot),
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });
    const hotbarCells = document.querySelectorAll(
      ".anarchy-hotbar .anarchy-inventory-slot",
    );

    for (let i = 1; i < HOTBAR_SLOTS; i++) {
      ui.selectHotbarSlot(i);
      expect(ui.selectedHotbarSlot()).toBe(i);
      expect(hotbarCells[i].classList.contains("selected")).toBe(true);
      // Only the current slot carries the highlight.
      for (let j = 0; j < HOTBAR_SLOTS; j++) {
        if (j === i) continue;
        expect(hotbarCells[j].classList.contains("selected")).toBe(false);
      }
    }
    // Wrap back to 0 mirrors the wheel-based wraparound the bootstrap drives.
    ui.selectHotbarSlot(0);
    expect(ui.selectedHotbarSlot()).toBe(0);
    // 8 forward steps (1..8) + 1 back to 0 = 9 distinct selection sends.
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0]);
  });

  it("hovering a populated cell surfaces a tooltip with the item name and count", () => {
    vi.useFakeTimers();
    try {
      inventory.replaceFromWire(
        fillSlots({
          0: { item: ItemId.Gold, count: 10 },
          2: { item: ItemId.Stone, count: 1 },
        }),
      );
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });

      const hotbarCells = document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      );

      // count > 1 → "Gold (10)".
      (hotbarCells[0] as HTMLElement).dispatchEvent(
        new PointerEvent("pointerenter", {
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      vi.advanceTimersByTime(300);
      let tooltip = document.getElementById("anarchy-tooltip")!;
      expect(tooltip.textContent).toBe("Gold (10)");

      (hotbarCells[0] as HTMLElement).dispatchEvent(
        new PointerEvent("pointerleave", { bubbles: true }),
      );

      // count === 1 → just the name, no count badge in the tooltip.
      (hotbarCells[2] as HTMLElement).dispatchEvent(
        new PointerEvent("pointerenter", {
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      vi.advanceTimersByTime(300);
      tooltip = document.getElementById("anarchy-tooltip")!;
      expect(tooltip.textContent).toBe("Stone");

      // Empty cell → tooltip stays hidden (getContent returns null).
      (hotbarCells[2] as HTMLElement).dispatchEvent(
        new PointerEvent("pointerleave", { bubbles: true }),
      );
      (hotbarCells[5] as HTMLElement).dispatchEvent(
        new PointerEvent("pointerenter", {
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      vi.advanceTimersByTime(300);
      tooltip = document.getElementById("anarchy-tooltip")!;
      expect(tooltip.style.display).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops mousedown / contextmenu inside the overlay from reaching window", () => {
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
      sendEquip: () => {},
      sendUnequip: () => {},
    });

    let windowHits = 0;
    const onWindow = (): void => {
      windowHits++;
    };
    window.addEventListener("mousedown", onWindow);
    window.addEventListener("contextmenu", onWindow);

    const hotbar = document.querySelector(".anarchy-hotbar")! as HTMLElement;
    hotbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const hotbarCtx = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    hotbar.dispatchEvent(hotbarCtx);
    expect(hotbarCtx.defaultPrevented).toBe(true);

    const panel = document.querySelector(
      ".anarchy-inventory-panel",
    )! as HTMLElement;
    panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const panelCtx = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    panel.dispatchEvent(panelCtx);
    expect(panelCtx.defaultPrevented).toBe(true);

    const equipmentBar = document.querySelector(
      ".anarchy-equipment-bar",
    )! as HTMLElement;
    const equipmentCtx = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    equipmentBar.dispatchEvent(equipmentCtx);
    expect(equipmentCtx.defaultPrevented).toBe(true);

    expect(windowHits).toBe(0);

    // Sanity: a click on document.body still reaches window — the stop is
    // scoped to the overlay roots, not global.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(windowHits).toBe(1);

    window.removeEventListener("mousedown", onWindow);
    window.removeEventListener("contextmenu", onWindow);
  });

  // Task 100 — equipment slots (pickaxe / axe mini-hotbar).
  describe("equipment slots", () => {
    function equipmentCells(): HTMLElement[] {
      return Array.from(
        document.querySelectorAll(
          ".anarchy-equipment-bar .anarchy-inventory-slot",
        ),
      ) as HTMLElement[];
    }

    it("renders four empty equipment cells next to the hotbar", () => {
      // Pickaxe + axe (task 100) + shovel (task 530) + utility (task 360).
      // Empty by default — silhouettes for the tool kinds, plain blank for
      // utility.
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const cells = equipmentCells();
      expect(cells).toHaveLength(4);
      // Empty cells get the `.empty` class (drives the silhouette opacity).
      expect(cells[0].classList.contains("empty")).toBe(true);
      expect(cells[1].classList.contains("empty")).toBe(true);
      expect(cells[2].classList.contains("empty")).toBe(true);
      expect(cells[3].classList.contains("empty")).toBe(true);
    });

    it("paints the equipped tool when populated", () => {
      // Equipment is a flag pointing at an inventory cell (task 010
      // rework). Place the tools at known slots and pass the slot
      // indices as the equipped pointers.
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[3] = { item: ItemId.IronPickaxe, count: 1 };
      slots[7] = { item: ItemId.WoodAxe, count: 1 };
      inventory.replaceFromWire(slots, 3, 7);
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const cells = equipmentCells();
      expect(cells[0].classList.contains("empty")).toBe(false);
      expect(cells[1].classList.contains("empty")).toBe(false);
      // Both cells contain a single icon child (the equipped texture).
      expect(cells[0].querySelector(".anarchy-inventory-icon")).not.toBeNull();
      expect(cells[1].querySelector(".anarchy-inventory-icon")).not.toBeNull();
    });

    it("clicking a pickaxe panel cell ships an EquipTool action", () => {
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.IronPickaxe, count: 1 },
        }),
      );
      const equips: Array<[number, string]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: () => {},
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 11,
          clientY: 10,
          bubbles: true,
        }),
      );
      expect(equips).toEqual([[HOTBAR_SLOTS, "pickaxe"]]);
    });

    it("clicking a non-tool panel cell still ships a MoveSlot, not an EquipTool", () => {
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 5 },
        }),
      );
      const moves: Array<[number, number]> = [];
      const equips: Array<[number, string]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: () => {},
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 11,
          clientY: 10,
          bubbles: true,
        }),
      );
      expect(equips).toEqual([]);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);
    });

    it("clicking the equipped tool's panel cell toggles to UnequipTool (task 570)", () => {
      // Pickaxe sits at panel slot 0 (= flat index HOTBAR_SLOTS) and is
      // currently equipped (pointer at that slot). A clean click on the
      // panel cell ships an Unequip rather than the redundant Equip.
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slots, HOTBAR_SLOTS, null);
      const equips: Array<[number, string]> = [];
      const unequips: string[] = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: (kind) => unequips.push(kind),
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 11,
          clientY: 10,
          bubbles: true,
        }),
      );
      expect(unequips).toEqual(["pickaxe"]);
      expect(equips).toEqual([]);
    });

    it("clicking a same-kind panel cell that isn't the equipped one ships an EquipTool — server overwrites the flag", () => {
      // A pickaxe is equipped at panel slot 0; clicking on a *different*
      // pickaxe in panel slot 5 must ship Equip(slot=5, kind=pickaxe) so
      // the server points its equipped flag at the new cell. No Unequip
      // emitted — the spec calls this a "swap" but the wire is just the
      // equip on the new cell.
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.WoodPickaxe, count: 1 };
      slots[HOTBAR_SLOTS + 5] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slots, HOTBAR_SLOTS, null);
      const equips: Array<[number, string]> = [];
      const unequips: string[] = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: (kind) => unequips.push(kind),
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      const otherPickaxeCell = panelCells[5] as HTMLElement;
      otherPickaxeCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 11,
          clientY: 10,
          bubbles: true,
        }),
      );
      expect(equips).toEqual([[HOTBAR_SLOTS + 5, "pickaxe"]]);
      expect(unequips).toEqual([]);
    });

    it("the panel-cell toggle distinguishes click from drag — drag wins the gesture", () => {
      // Clicking an equipped tool toggles unequip; dragging the same
      // cell still routes through the regular MoveSlot pipeline. With
      // the equipped pickaxe at panel slot 0, drag it onto panel slot
      // 7 → MoveSlot fires, NO Unequip.
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slots, HOTBAR_SLOTS, null);
      const moves: Array<[number, number]> = [];
      const unequips: string[] = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: (kind) => unequips.push(kind),
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      const src = panelCells[0] as HTMLElement;
      const dst = panelCells[7] as HTMLElement;
      const original = document.elementsFromPoint;
      document.elementsFromPoint = ((_x: number, _y: number) => [
        dst,
      ]) as typeof document.elementsFromPoint;
      src.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.elementsFromPoint = original;
      expect(unequips).toEqual([]);
      expect(moves).toEqual([[HOTBAR_SLOTS, HOTBAR_SLOTS + 7]]);
    });

    it("clicking an occupied equipment slot ships an UnequipTool action", () => {
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[3] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slots, 3, null);
      const unequips: string[] = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: (kind) => unequips.push(kind),
      });
      const cells = equipmentCells();
      cells[0].click();
      expect(unequips).toEqual(["pickaxe"]);
    });

    it("clicking an empty equipment slot is a no-op", () => {
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {
          throw new Error("must not be called for an empty slot click");
        },
      });
      equipmentCells()[0].click();
    });

    it("dragging a pickaxe onto the pickaxe slot ships an EquipTool", () => {
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.WoodPickaxe, count: 1 },
        }),
      );
      const equips: Array<[number, string]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: () => {},
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      const pickaxeCell = equipmentCells()[0];
      const original = document.elementsFromPoint;
      document.elementsFromPoint = ((_x: number, _y: number) => [
        pickaxeCell,
      ]) as typeof document.elementsFromPoint;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.elementsFromPoint = original;
      expect(equips).toEqual([[HOTBAR_SLOTS, "pickaxe"]]);
    });

    it("dragging a pickaxe onto the axe slot is rejected (kind guard)", () => {
      inventory.replaceFromWire(
        fillSlots({
          [HOTBAR_SLOTS]: { item: ItemId.WoodPickaxe, count: 1 },
        }),
      );
      const equips: Array<[number, string]> = [];
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: () => {},
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      const axeCell = equipmentCells()[1];
      const original = document.elementsFromPoint;
      document.elementsFromPoint = ((_x: number, _y: number) => [
        axeCell,
      ]) as typeof document.elementsFromPoint;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.elementsFromPoint = original;
      expect(equips).toEqual([]);
      expect(moves).toEqual([]);
    });

    it("re-renders equipment cells reactively when InventoryUpdate flips equip / unequip", () => {
      // Task 130 contract: the equipment-slot UI must re-paint when an
      // `InventoryUpdate` carries a different equipped tool — both for the
      // empty → populated transition (equip) and the populated → empty
      // transition (unequip). The hotbar / panel re-render path is tested
      // separately above; here we scope the assertion to the equipment row.
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });

      const empty: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      // Place tools in known cells so the equipped flag has somewhere
      // to point. The mini-hotbar mirrors the equipped cell (task 010
      // rework).
      const withTools: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      withTools[3] = { item: ItemId.IronPickaxe, count: 1 };
      withTools[7] = { item: ItemId.WoodAxe, count: 1 };
      // Initial state: both equipment slots empty.
      let cells = equipmentCells();
      expect(cells[0].classList.contains("empty")).toBe(true);
      expect(cells[1].classList.contains("empty")).toBe(true);

      // Equip a pickaxe — cells re-render, pickaxe slot lights up with an
      // icon, axe slot stays empty.
      inventory.replaceFromWire(withTools, 3, null);
      cells = equipmentCells();
      expect(cells[0].classList.contains("empty")).toBe(false);
      expect(cells[0].querySelector(".anarchy-inventory-icon")).not.toBeNull();
      expect(cells[1].classList.contains("empty")).toBe(true);

      // Equip an axe alongside — both populated.
      inventory.replaceFromWire(withTools, 3, 7);
      cells = equipmentCells();
      expect(cells[0].classList.contains("empty")).toBe(false);
      expect(cells[1].classList.contains("empty")).toBe(false);
      expect(cells[1].querySelector(".anarchy-inventory-icon")).not.toBeNull();

      // Unequip both — cells return to the empty silhouette state.
      inventory.replaceFromWire(empty);
      cells = equipmentCells();
      expect(cells[0].classList.contains("empty")).toBe(true);
      expect(cells[1].classList.contains("empty")).toBe(true);
    });

    it("dragging from an equipment slot onto a panel slot ships an UnequipTool", () => {
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[3] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slots, 3, null);
      const unequips: string[] = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: (kind) => unequips.push(kind),
      });
      const pickaxeCell = equipmentCells()[0];
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[5] as HTMLElement;
      const original = document.elementsFromPoint;
      document.elementsFromPoint = ((_x: number, _y: number) => [
        panelCell,
      ]) as typeof document.elementsFromPoint;
      pickaxeCell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.elementsFromPoint = original;
      expect(unequips).toEqual(["pickaxe"]);
    });

    it("paints orange highlight on the equipped pickaxe cell and green on the equipped axe cell", () => {
      // Task 010 rework: equipment is a flag on a cell; the cell renders
      // with an `equipped-pickaxe` (orange) or `equipped-axe` (green)
      // class so the player can see at a glance which cell is the
      // equipped tool. The mini-hotbar mirrors the cell — it's not the
      // owner anymore.
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      // Pickaxe in the first hotbar cell, axe in panel slot 5 (= flat
      // index HOTBAR_SLOTS + 5). Picking distinct rows means the
      // assertions don't accidentally agree by sharing a single cell.
      slots[0] = { item: ItemId.IronPickaxe, count: 1 };
      slots[HOTBAR_SLOTS + 5] = { item: ItemId.WoodAxe, count: 1 };
      inventory.replaceFromWire(slots, 0, HOTBAR_SLOTS + 5);
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const hotbarCells = document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      );
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      expect(hotbarCells[0].classList.contains("equipped-pickaxe")).toBe(true);
      expect(hotbarCells[0].classList.contains("equipped-axe")).toBe(false);
      expect(hotbarCells[1].classList.contains("equipped-pickaxe")).toBe(false);
      expect(panelCells[5].classList.contains("equipped-axe")).toBe(true);
      expect(panelCells[5].classList.contains("equipped-pickaxe")).toBe(false);
      expect(panelCells[0].classList.contains("equipped-axe")).toBe(false);
    });

    it("right-click on a non-empty cell arms the split source with a yellow border", () => {
      // BACKLOG 410: first right-click on a non-empty cell paints
      // `.split-source`. Sticky until a left-click clears it.
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.Gold, count: 10 };
      inventory.replaceFromWire(slots);
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(panelCell.classList.contains("split-source")).toBe(true);
    });

    it("right-click on an empty cell does not arm a split source", () => {
      // No item to split — the right-click is inert.
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCell = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[0] as HTMLElement;
      panelCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(panelCell.classList.contains("split-source")).toBe(false);
    });

    it("right-click on a destination after arming ships TransferItems(src, dst, 1)", () => {
      // After arming the source, a right-click on a different cell
      // ships one transfer immediately (the press itself is the first
      // frame; the timer ramps from there for held presses).
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.Gold, count: 10 };
      inventory.replaceFromWire(slots);
      const transfers: Array<[number, number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: (src, dst, count) => transfers.push([src, dst, count]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      const sourceCell = panelCells[0] as HTMLElement;
      const destCell = panelCells[1] as HTMLElement;
      // Arm.
      sourceCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      // Press on dest — first frame fires immediately.
      destCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(transfers).toEqual([[HOTBAR_SLOTS, HOTBAR_SLOTS + 1, 1]]);
      // Release stops any future timer ticks; release does not clear
      // the source — re-pressing resumes.
      document.dispatchEvent(
        new PointerEvent("pointerup", { button: 2, bubbles: true }),
      );
      expect(sourceCell.classList.contains("split-source")).toBe(true);
    });

    it("a left-click clears the sticky split source", () => {
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.Gold, count: 10 };
      inventory.replaceFromWire(slots);
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      const sourceCell = panelCells[0] as HTMLElement;
      sourceCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(sourceCell.classList.contains("split-source")).toBe(true);
      // Left-click anywhere clears the source. Use the same cell here
      // — the per-cell left-click handler clears split.
      sourceCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, bubbles: true }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", { button: 0, bubbles: true }),
      );
      expect(sourceCell.classList.contains("split-source")).toBe(false);
    });

    it("right-click on the armed source toggles the selection off", () => {
      const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slots[HOTBAR_SLOTS] = { item: ItemId.Gold, count: 10 };
      inventory.replaceFromWire(slots);
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      const sourceCell = panelCells[0] as HTMLElement;
      sourceCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(sourceCell.classList.contains("split-source")).toBe(true);
      sourceCell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(sourceCell.classList.contains("split-source")).toBe(false);
    });

    it("re-points the equipped highlight when InventoryUpdate moves the tool", () => {
      // The flag-on-cell model means the highlight follows the slot
      // index the server ships. A subsequent `InventoryUpdate` whose
      // equipped slot pointer changes must re-light the new cell and
      // dim the old one.
      const slotsA: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slotsA[2] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slotsA, 2, null);
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      let hotbarCells = document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      );
      expect(hotbarCells[2].classList.contains("equipped-pickaxe")).toBe(true);

      // Same pickaxe, different slot — the highlight follows.
      const slotsB: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
      slotsB[5] = { item: ItemId.IronPickaxe, count: 1 };
      inventory.replaceFromWire(slotsB, 5, null);
      hotbarCells = document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      );
      expect(hotbarCells[2].classList.contains("equipped-pickaxe")).toBe(false);
      expect(hotbarCells[5].classList.contains("equipped-pickaxe")).toBe(true);
    });
  });

  describe("hotbar drag/drop + right-click split (task 20)", () => {
    function dragWithStubbedHitTest(
      src: HTMLElement,
      dst: HTMLElement,
    ): void {
      const original = document.elementsFromPoint;
      document.elementsFromPoint = ((_x: number, _y: number) => [
        dst,
      ]) as typeof document.elementsFromPoint;
      src.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 200,
          clientY: 200,
          bubbles: true,
        }),
      );
      document.elementsFromPoint = original;
    }

    function hotbarCellAt(idx: number): HTMLElement {
      return document.querySelectorAll(
        ".anarchy-hotbar .anarchy-inventory-slot",
      )[idx] as HTMLElement;
    }

    function panelCellAt(idx: number): HTMLElement {
      return document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      )[idx] as HTMLElement;
    }

    it("dragging from a hotbar cell onto a panel cell ships MoveSlot(hotbar→panel)", () => {
      inventory.replaceFromWire(
        fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      dragWithStubbedHitTest(hotbarCellAt(0), panelCellAt(2));
      expect(moves).toEqual([[0, HOTBAR_SLOTS + 2]]);
    });

    it("dragging from a panel cell onto a hotbar cell ships MoveSlot(panel→hotbar)", () => {
      inventory.replaceFromWire(
        fillSlots({ [HOTBAR_SLOTS + 4]: { item: ItemId.Gold, count: 5 } }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      dragWithStubbedHitTest(panelCellAt(4), hotbarCellAt(7));
      expect(moves).toEqual([[HOTBAR_SLOTS + 4, 7]]);
    });

    it("dragging a tool from a hotbar cell onto its equipment slot ships EquipTool", () => {
      inventory.replaceFromWire(
        fillSlots({ 2: { item: ItemId.IronPickaxe, count: 1 } }),
      );
      const equips: Array<[number, string]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendEquip: (slot, kind) => equips.push([slot, kind]),
        sendUnequip: () => {},
      });
      const equipPickaxe = document.querySelector(
        ".anarchy-equipment-slot-pickaxe",
      ) as HTMLElement;
      dragWithStubbedHitTest(hotbarCellAt(2), equipPickaxe);
      expect(equips).toEqual([[2, "pickaxe"]]);
    });

    it("a click on a hotbar cell still selects (no drag promotion, no MoveSlot fires)", () => {
      // The drag-vs-click discrimination at DRAG_THRESHOLD_PX_SQ must
      // preserve the existing left-click-to-select affordance: a
      // pointerdown + pointerup at the same coords should leave moves
      // empty and flip selection via the per-cell click listener.
      inventory.replaceFromWire(
        fillSlots({ 0: { item: ItemId.Gold, count: 4 } }),
      );
      const moves: Array<[number, number]> = [];
      const selects: number[] = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: (slot) => selects.push(slot),
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const cell = hotbarCellAt(3);
      cell.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      // The click event fires only when down+up land on the same cell —
      // simulate it directly since happy-dom doesn't synthesize it.
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(moves).toEqual([]);
      expect(selects).toEqual([3]);
    });

    it("a small pointermove under threshold still resolves as a click (no drag promotion)", () => {
      inventory.replaceFromWire(
        fillSlots({ 0: { item: ItemId.Gold, count: 4 } }),
      );
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const src = hotbarCellAt(0);
      src.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      // Wiggle by 2 px (well under sqrt(25) = 5 px threshold).
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 12,
          clientY: 11,
          bubbles: true,
        }),
      );
      // No drag preview means we never promoted.
      expect(
        document.querySelector(".anarchy-inventory-drag-preview"),
      ).toBeNull();
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          button: 0,
          clientX: 12,
          clientY: 11,
          bubbles: true,
        }),
      );
      expect(moves).toEqual([]);
    });

    it("right-click on a hotbar cell arms a split source", () => {
      inventory.replaceFromWire(
        fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
      );
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: () => {},
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      const cell = hotbarCellAt(0);
      cell.dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(cell.classList.contains("split-source")).toBe(true);
    });

    it("right-click split from a hotbar cell to a panel cell ships TransferItems(src, dst, 1)", () => {
      inventory.replaceFromWire(
        fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
      );
      const transfers: Array<[number, number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: (src, dst, count) => transfers.push([src, dst, count]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      hotbarCellAt(0).dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      panelCellAt(3).dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(transfers).toEqual([[0, HOTBAR_SLOTS + 3, 1]]);
    });

    it("right-click split from a panel cell to a hotbar cell ships TransferItems(src, dst, 1)", () => {
      inventory.replaceFromWire(
        fillSlots({ [HOTBAR_SLOTS]: { item: ItemId.Gold, count: 10 } }),
      );
      const transfers: Array<[number, number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: (src, dst, count) => transfers.push([src, dst, count]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      panelCellAt(0).dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      hotbarCellAt(5).dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(transfers).toEqual([[HOTBAR_SLOTS, 5, 1]]);
    });

    it("right-click split from a hotbar cell to another hotbar cell ships TransferItems(src, dst, 1)", () => {
      inventory.replaceFromWire(
        fillSlots({ 0: { item: ItemId.Gold, count: 10 } }),
      );
      const transfers: Array<[number, number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: () => {},
        sendTransfer: (src, dst, count) => transfers.push([src, dst, count]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      hotbarCellAt(0).dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      hotbarCellAt(4).dispatchEvent(
        new PointerEvent("pointerdown", { button: 2, bubbles: true }),
      );
      expect(transfers).toEqual([[0, 4, 1]]);
    });

    it("dragging from an empty hotbar cell does not ship a MoveSlot", () => {
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
        sendEquip: () => {},
        sendUnequip: () => {},
      });
      dragWithStubbedHitTest(hotbarCellAt(0), panelCellAt(0));
      expect(moves).toEqual([]);
    });

  });
});
