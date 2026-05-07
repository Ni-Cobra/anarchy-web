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

  it("renders an empty inventory: 9 hotbar cells, 36 panel cells laid out 4 cols × 9 rows, panel hidden", () => {
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
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

    const icons = document.querySelectorAll(".anarchy-inventory-icon");
    expect(icons).toHaveLength(0);

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
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
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

  it("re-renders reactively when the inventory mutates", () => {
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
    });

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
    const ui = mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
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
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([[HOTBAR_SLOTS, 0]]);
    });

    it("clicking an empty panel cell is a no-op", () => {
      const moves: Array<[number, number]> = [];
      mountInventoryUi({
        getInventory: () => inventory,
        sendSelect: () => {},
        sendMove: (src, dst) => moves.push([src, dst]),
      });
      const panelCells = document.querySelectorAll(
        ".anarchy-inventory-panel .anarchy-inventory-slot",
      );
      clickGesture(panelCells[0] as HTMLElement);
      expect(moves).toEqual([]);
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

  it("stops mousedown / contextmenu inside the overlay from reaching window", () => {
    mountInventoryUi({
      getInventory: () => inventory,
      sendSelect: () => {},
      sendMove: () => {},
    });

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
