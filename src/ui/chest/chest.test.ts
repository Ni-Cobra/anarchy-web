// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChestState,
  type ChestLocation,
  chestKeyOf,
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  type Slot,
} from "../../game/index.js";
import { mountInventoryUi, type InventoryUiHandle } from "../inventory/index.js";
import { _resetTooltipForTests } from "../tooltip.js";
import { mountChestUi } from "./index.js";

interface MoveRecord {
  src: number;
  dst: number;
  srcChestKey: string | null;
  dstChestKey: string | null;
}

interface TransferRecord extends MoveRecord {
  count: number;
}

interface CloseRecord {
  chest: ChestLocation;
}

interface MountResult {
  inventoryUi: InventoryUiHandle;
  moves: MoveRecord[];
  transfers: TransferRecord[];
  closes: CloseRecord[];
  playerInv: Inventory;
  chestState: ChestState;
}

const DEFAULT_LOC: ChestLocation = { cx: 0, cy: 0, lx: 0, ly: 0 };
const DEFAULT_KEY = chestKeyOf(DEFAULT_LOC);

function emptySlots(): Slot[] {
  return Array.from({ length: INVENTORY_SIZE }, () => null);
}

function mountUis(
  player: Slot[] = emptySlots(),
  chest: Slot[] | null = emptySlots(),
  loc: ChestLocation = DEFAULT_LOC,
): MountResult {
  const playerInv = new Inventory();
  playerInv.replaceFromWire(player);
  const chestState = new ChestState();
  if (chest !== null) {
    chestState.replaceFromWire(loc, chest);
  }
  const moves: MoveRecord[] = [];
  const transfers: TransferRecord[] = [];
  const closes: CloseRecord[] = [];
  const inventoryUi = mountInventoryUi({
    getInventory: () => playerInv,
    getChestInventory: (key) => chestState.inventoryForKey(key),
    sendSelect: () => {},
    sendMove: (src, dst, srcChestKey = null, dstChestKey = null) =>
      moves.push({
        src,
        dst,
        srcChestKey: srcChestKey ?? null,
        dstChestKey: dstChestKey ?? null,
      }),
    sendTransfer: (src, dst, count, srcChestKey = null, dstChestKey = null) =>
      transfers.push({
        src,
        dst,
        count,
        srcChestKey: srcChestKey ?? null,
        dstChestKey: dstChestKey ?? null,
      }),
    sendEquip: () => {},
    sendUnequip: () => {},
  });
  mountChestUi({
    chestState,
    inventoryUi,
    sendCloseChest: (chest) => closes.push({ chest }),
  });
  return { inventoryUi, moves, transfers, closes, playerInv, chestState };
}

function chestCells(): HTMLDivElement[] {
  return Array.from(
    document.querySelectorAll(".anarchy-chest-panel .anarchy-chest-slot"),
  ) as HTMLDivElement[];
}

function panelCells(): HTMLDivElement[] {
  return Array.from(
    document.querySelectorAll(".anarchy-inventory-panel .anarchy-inventory-slot"),
  ) as HTMLDivElement[];
}

function hotbarCells(): HTMLDivElement[] {
  return Array.from(
    document.querySelectorAll(".anarchy-hotbar .anarchy-inventory-slot"),
  ) as HTMLDivElement[];
}

function dragGesture(src: HTMLElement, dst: HTMLElement): void {
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

describe("chest cross-grid drag/drop + split (task 535/591)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  it("renders the chest panel with 45 cells when a chest is open", () => {
    mountUis();
    const cells = chestCells();
    expect(cells).toHaveLength(INVENTORY_SIZE);
    const panel = document.querySelector(".anarchy-chest-panel")!;
    expect(panel.classList.contains("open")).toBe(true);
  });

  it("does not mount a panel when no chest is open", () => {
    mountUis(emptySlots(), null);
    expect(document.querySelector(".anarchy-chest-panel")).toBeNull();
  });

  it("dragging from a player panel cell onto a chest cell ships MoveSlot with dstChestKey", () => {
    const player = emptySlots();
    player[HOTBAR_SLOTS] = { item: ItemId.Gold, count: 10 };
    const { moves } = mountUis(player);

    const src = panelCells()[0];
    const dst = chestCells()[5];
    dragGesture(src, dst);

    expect(moves).toEqual([
      {
        src: HOTBAR_SLOTS,
        dst: 5,
        srcChestKey: null,
        dstChestKey: DEFAULT_KEY,
      },
    ]);
  });

  it("dragging from a chest cell onto a player panel cell ships MoveSlot with srcChestKey", () => {
    const chest = emptySlots();
    chest[3] = { item: ItemId.Gold, count: 10 };
    const { moves } = mountUis(emptySlots(), chest);

    const src = chestCells()[3];
    const dst = panelCells()[7];
    dragGesture(src, dst);

    expect(moves).toEqual([
      {
        src: 3,
        dst: HOTBAR_SLOTS + 7,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: null,
      },
    ]);
  });

  it("dragging from one chest cell onto another chest cell ships MoveSlot with both keys", () => {
    const chest = emptySlots();
    chest[2] = { item: ItemId.Gold, count: 10 };
    const { moves } = mountUis(emptySlots(), chest);

    const src = chestCells()[2];
    const dst = chestCells()[8];
    dragGesture(src, dst);

    expect(moves).toEqual([
      {
        src: 2,
        dst: 8,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: DEFAULT_KEY,
      },
    ]);
  });

  it("dragging from an empty chest cell does not ship a MoveSlot", () => {
    const { moves } = mountUis();
    dragGesture(chestCells()[0], panelCells()[0]);
    expect(moves).toEqual([]);
  });

  it("clicking a non-empty chest cell ships MoveSlot(chest → first free main slot)", () => {
    const chest = emptySlots();
    chest[4] = { item: ItemId.Gold, count: 10 };
    const { moves } = mountUis(emptySlots(), chest);

    const cell = chestCells()[4];
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

    expect(moves).toEqual([
      {
        src: 4,
        dst: HOTBAR_SLOTS,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: null,
      },
    ]);
  });

  it("clicking an empty chest cell is a no-op", () => {
    const { moves } = mountUis();
    const cell = chestCells()[0];
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
    expect(moves).toEqual([]);
  });

  it("clicking a chest cell when the player panel is full falls back to a free hotbar slot", () => {
    const player = emptySlots();
    for (let i = HOTBAR_SLOTS; i < INVENTORY_SIZE; i++) {
      player[i] = { item: ItemId.Stone, count: 1 };
    }
    const chest = emptySlots();
    chest[0] = { item: ItemId.Gold, count: 10 };
    const { moves } = mountUis(player, chest);

    chestCells()[0].dispatchEvent(
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

    expect(moves).toEqual([
      {
        src: 0,
        dst: 0,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: null,
      },
    ]);
  });

  it("right-click on a chest cell arms the split source with a yellow border", () => {
    const chest = emptySlots();
    chest[0] = { item: ItemId.Gold, count: 10 };
    mountUis(emptySlots(), chest);

    const cell = chestCells()[0];
    cell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true }),
    );
    expect(cell.classList.contains("split-source")).toBe(true);
  });

  it("right-click split from chest → player ships TransferItems with srcChestKey", () => {
    const chest = emptySlots();
    chest[0] = { item: ItemId.Gold, count: 10 };
    const { transfers } = mountUis(emptySlots(), chest);

    const sourceCell = chestCells()[0];
    const destCell = panelCells()[3];
    sourceCell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true }),
    );
    destCell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true }),
    );

    expect(transfers).toEqual([
      {
        src: 0,
        dst: HOTBAR_SLOTS + 3,
        count: 1,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: null,
      },
    ]);
  });

  it("right-click split from player → chest ships TransferItems with dstChestKey", () => {
    const player = emptySlots();
    player[HOTBAR_SLOTS] = { item: ItemId.Gold, count: 10 };
    const { transfers } = mountUis(player);

    const sourceCell = panelCells()[0];
    const destCell = chestCells()[7];
    sourceCell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true }),
    );
    destCell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true }),
    );

    expect(transfers).toEqual([
      {
        src: HOTBAR_SLOTS,
        dst: 7,
        count: 1,
        srcChestKey: null,
        dstChestKey: DEFAULT_KEY,
      },
    ]);
  });

  it("dragging from a chest cell onto an equipment slot is rejected (no wire surface)", () => {
    const chest = emptySlots();
    chest[2] = { item: ItemId.IronPickaxe, count: 1 };
    const { moves } = mountUis(emptySlots(), chest);

    const src = chestCells()[2];
    const equipmentSlot = document.querySelector(
      ".anarchy-equipment-bar .anarchy-inventory-slot",
    ) as HTMLDivElement;
    dragGesture(src, equipmentSlot);
    expect(moves).toEqual([]);
  });

  it("dragging from an equipment slot onto a chest cell is rejected (server picks dst on unequip)", () => {
    const player = emptySlots();
    player[3] = { item: ItemId.IronPickaxe, count: 1 };
    const playerInv = new Inventory();
    playerInv.replaceFromWire(player, 3, null);
    const chestState = new ChestState();
    chestState.replaceFromWire(DEFAULT_LOC, emptySlots());
    const moves: MoveRecord[] = [];
    let unequipCount = 0;
    const inventoryUi = mountInventoryUi({
      getInventory: () => playerInv,
      getChestInventory: (key) => chestState.inventoryForKey(key),
      sendSelect: () => {},
      sendMove: (src, dst, srcChestKey = null, dstChestKey = null) =>
        moves.push({
          src,
          dst,
          srcChestKey: srcChestKey ?? null,
          dstChestKey: dstChestKey ?? null,
        }),
      sendEquip: () => {},
      sendUnequip: () => {
        unequipCount += 1;
      },
    });
    mountChestUi({ chestState, inventoryUi, sendCloseChest: () => {} });

    const equipmentSlot = document.querySelector(
      ".anarchy-equipment-bar .anarchy-inventory-slot",
    ) as HTMLDivElement;
    const dst = chestCells()[0];
    dragGesture(equipmentSlot, dst);
    expect(moves).toEqual([]);
    expect(unequipCount).toBe(0);
  });

  it("left-click on a player cell clears a chest-armed split source", () => {
    const chest = emptySlots();
    chest[0] = { item: ItemId.Gold, count: 10 };
    mountUis(emptySlots(), chest);

    const sourceCell = chestCells()[0];
    sourceCell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true }),
    );
    expect(sourceCell.classList.contains("split-source")).toBe(true);

    const playerCell = hotbarCells()[0];
    playerCell.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, bubbles: true }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", { button: 0, bubbles: true }),
    );

    expect(sourceCell.classList.contains("split-source")).toBe(false);
  });

  it("suppresses the native context menu on both chest cells and the panel root", () => {
    mountUis();

    const cellCtx = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    chestCells()[0].dispatchEvent(cellCtx);
    expect(cellCtx.defaultPrevented).toBe(true);

    const panel = document.querySelector(".anarchy-chest-panel")! as HTMLElement;
    const panelCtx = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    panel.dispatchEvent(panelCtx);
    expect(panelCtx.defaultPrevented).toBe(true);
  });

  it("dragging from a chest cell paints the source highlight on the chest cell", () => {
    const chest = emptySlots();
    chest[1] = { item: ItemId.Gold, count: 10 };
    mountUis(emptySlots(), chest);

    const src = chestCells()[1];
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
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );
    expect(src.classList.contains("drag-source")).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(src.classList.contains("drag-source")).toBe(false);
  });
});

describe("chest panel chrome (task 591)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  it("renders a header with a title and an X button when a chest opens", () => {
    mountUis();
    const header = document.querySelector(".anarchy-chest-header");
    expect(header).not.toBeNull();
    const titleText = header!.querySelector(".anarchy-chest-title-text");
    expect(titleText?.textContent).toBe("Chest");
    const close = header!.querySelector(".anarchy-chest-close");
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe("Close chest");
  });

  it("X-button click ships sendCloseChest with the panel's location", () => {
    const loc: ChestLocation = { cx: 1, cy: 2, lx: 3, ly: 4 };
    const { closes } = mountUis(emptySlots(), emptySlots(), loc);
    const closeBtn = document.querySelector(".anarchy-chest-close") as HTMLButtonElement;
    closeBtn.click();
    expect(closes).toEqual([{ chest: loc }]);
  });

  it("X-button pointerdown does not start a header drag", () => {
    mountUis();
    const closeBtn = document.querySelector(".anarchy-chest-close") as HTMLElement;
    const header = document.querySelector(".anarchy-chest-header") as HTMLElement;
    closeBtn.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 5,
        clientY: 5,
        bubbles: true,
      }),
    );
    expect(header.classList.contains("dragging")).toBe(false);
  });

  it("header pointerdown + pointermove repositions the panel via CSS transform", () => {
    mountUis();
    const header = document.querySelector(".anarchy-chest-header") as HTMLElement;
    const panel = document.querySelector(".anarchy-chest-panel") as HTMLElement;
    const initialTransform = panel.style.transform;
    expect(initialTransform).toContain("translate(");

    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 300,
        clientY: 100,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 400,
        clientY: 200,
        bubbles: true,
      }),
    );
    expect(header.classList.contains("dragging")).toBe(true);
    // The panel writes via `transform: translate(x, y)` — not `left/top`.
    expect(panel.style.transform).not.toBe(initialTransform);
    expect(panel.style.transform).toMatch(/translate\(/);
    expect(panel.style.top).toBe("");
    expect(panel.style.left).toBe("");
  });

  it("header drag does not propagate pointerdown to chest cells (no MoveSlot)", () => {
    const chest = emptySlots();
    chest[0] = { item: ItemId.Gold, count: 10 };
    const { moves } = mountUis(emptySlots(), chest);
    const header = document.querySelector(".anarchy-chest-header") as HTMLElement;
    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 300,
        clientY: 100,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 400,
        clientY: 200,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 400,
        clientY: 200,
        bubbles: true,
      }),
    );
    expect(moves).toEqual([]);
  });

  it("viewport clamp keeps the header reachable when dragged off-screen", () => {
    mountUis();
    const header = document.querySelector(".anarchy-chest-header") as HTMLElement;
    const panel = document.querySelector(".anarchy-chest-panel") as HTMLElement;
    // Start drag at (300, 100). Move far past the top-left corner so
    // the unclamped target would push the panel off-screen.
    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 300,
        clientY: 100,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: -5000,
        clientY: -5000,
        bubbles: true,
      }),
    );
    const match = panel.style.transform.match(/translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)/);
    expect(match).not.toBeNull();
    const x = Number(match![1]);
    const y = Number(match![2]);
    // Top edge cannot push the header above the viewport — y must be ≥ 0.
    expect(y).toBeGreaterThanOrEqual(0);
    // Left edge: at least HEADER_MIN_VISIBLE_PX (30) of the panel
    // remains inside, so x ≥ 30 - panelWidth.
    expect(x).toBeGreaterThanOrEqual(30 - 600);
  });

  it("releasing the drag clears the header `dragging` class", () => {
    mountUis();
    const header = document.querySelector(".anarchy-chest-header") as HTMLElement;
    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 300,
        clientY: 100,
        bubbles: true,
      }),
    );
    expect(header.classList.contains("dragging")).toBe(true);
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 300,
        clientY: 100,
        bubbles: true,
      }),
    );
    expect(header.classList.contains("dragging")).toBe(false);
  });
});

describe("chest panel manager (task 591)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  it("mounts exactly one panel when chestState opens", () => {
    mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    expect(panels).toHaveLength(1);
  });

  it("unmounts the panel when chestState closes", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    expect(document.querySelectorAll(".anarchy-chest-panel")).toHaveLength(1);
    chestState.closeFromWire(DEFAULT_LOC);
    expect(document.querySelectorAll(".anarchy-chest-panel")).toHaveLength(0);
  });

  it("cross-grid drag still routes a freshly-opened chest's chestKey", () => {
    const { moves, chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    const other: ChestLocation = { cx: 7, cy: 7, lx: 2, ly: 3 };
    const otherKey = chestKeyOf(other);
    const fill = emptySlots();
    fill[0] = { item: ItemId.Gold, count: 5 };
    chestState.replaceFromWire(other, fill);

    // Two panels are mounted now (DEFAULT + other). Find the second
    // panel's slot 0 and drag it onto the player panel.
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    expect(panels).toHaveLength(2);
    const src = panels[1].querySelectorAll(".anarchy-chest-slot")[0] as HTMLDivElement;
    const dst = panelCells()[0];
    dragGesture(src, dst);
    expect(moves).toEqual([
      {
        src: 0,
        dst: HOTBAR_SLOTS,
        srcChestKey: otherKey,
        dstChestKey: null,
      },
    ]);
  });
});

describe("chest multi-panel manager (task 592)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  const SECOND_LOC: ChestLocation = { cx: 5, cy: 6, lx: 7, ly: 8 };
  const SECOND_KEY = chestKeyOf(SECOND_LOC);

  function transformXY(panel: HTMLElement): { x: number; y: number } {
    const match = panel.style.transform.match(
      /translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)/,
    );
    if (match === null) return { x: NaN, y: NaN };
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  it("opening chest B while A is open mounts B alongside A (both stay)", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    expect(document.querySelectorAll(".anarchy-chest-panel")).toHaveLength(1);

    chestState.replaceFromWire(SECOND_LOC, emptySlots());
    expect(document.querySelectorAll(".anarchy-chest-panel")).toHaveLength(2);
  });

  it("staggers the second panel from the first along both axes", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    const a = transformXY(panels[0] as HTMLElement);
    const b = transformXY(panels[1] as HTMLElement);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it("newly-opened panel mounts on top (highest z-index, focused class)", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    const aZ = Number((panels[0] as HTMLElement).style.zIndex);
    const bZ = Number((panels[1] as HTMLElement).style.zIndex);
    expect(bZ).toBeGreaterThan(aZ);
    expect((panels[1] as HTMLElement).classList.contains("focused")).toBe(true);
    expect((panels[0] as HTMLElement).classList.contains("focused")).toBe(false);
  });

  it("clicking the bottom panel raises it above the top (z-index + focused swap)", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    const a = panels[0] as HTMLElement;
    const b = panels[1] as HTMLElement;
    expect(Number(b.style.zIndex)).toBeGreaterThan(Number(a.style.zIndex));

    // Click on A's header — drag-arming pointerdown raises focus on
    // mousedown per the panel manager contract.
    const aHeader = a.querySelector(".anarchy-chest-header") as HTMLElement;
    aHeader.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );

    expect(Number(a.style.zIndex)).toBeGreaterThan(Number(b.style.zIndex));
    expect(a.classList.contains("focused")).toBe(true);
    expect(b.classList.contains("focused")).toBe(false);
  });

  it("clicking inside a panel body (a cell) also raises it", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    const a = panels[0] as HTMLElement;
    const b = panels[1] as HTMLElement;
    expect(Number(b.style.zIndex)).toBeGreaterThan(Number(a.style.zIndex));

    const aFirstCell = a.querySelector(".anarchy-chest-slot") as HTMLElement;
    aFirstCell.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );

    expect(Number(a.style.zIndex)).toBeGreaterThan(Number(b.style.zIndex));
    expect(a.classList.contains("focused")).toBe(true);
    expect(b.classList.contains("focused")).toBe(false);
  });

  it("closing one panel leaves the other mounted and focused", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());
    expect(document.querySelectorAll(".anarchy-chest-panel")).toHaveLength(2);

    chestState.closeFromWire(DEFAULT_LOC);
    const panels = document.querySelectorAll(".anarchy-chest-panel");
    expect(panels).toHaveLength(1);
    expect((panels[0] as HTMLElement).classList.contains("focused")).toBe(true);
  });

  it("drop from chest A's slot onto chest B's slot ships MoveSlot with both keys", () => {
    const aFill = emptySlots();
    aFill[2] = { item: ItemId.Gold, count: 10 };
    const { moves, chestState } = mountUis(emptySlots(), aFill, DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());

    const panels = document.querySelectorAll(".anarchy-chest-panel");
    const src = panels[0].querySelectorAll(".anarchy-chest-slot")[2] as HTMLDivElement;
    const dst = panels[1].querySelectorAll(".anarchy-chest-slot")[7] as HTMLDivElement;
    dragGesture(src, dst);

    expect(moves).toEqual([
      {
        src: 2,
        dst: 7,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: SECOND_KEY,
      },
    ]);
  });

  it("right-click split across two chest panels ships TransferItems with both keys", () => {
    const aFill = emptySlots();
    aFill[0] = { item: ItemId.Gold, count: 10 };
    const { transfers, chestState } = mountUis(emptySlots(), aFill, DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());

    const panels = document.querySelectorAll(".anarchy-chest-panel");
    const src = panels[0].querySelectorAll(".anarchy-chest-slot")[0] as HTMLDivElement;
    const dst = panels[1].querySelectorAll(".anarchy-chest-slot")[5] as HTMLDivElement;
    src.dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true }));
    dst.dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true }));

    expect(transfers).toEqual([
      {
        src: 0,
        dst: 5,
        count: 1,
        srcChestKey: DEFAULT_KEY,
        dstChestKey: SECOND_KEY,
      },
    ]);
  });

  it("updating chest A's contents does not fire chest B's per-key listener", () => {
    const { chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, emptySlots());

    let aFires = 0;
    let bFires = 0;
    chestState.subscribeKey(DEFAULT_KEY, () => {
      aFires += 1;
    });
    chestState.subscribeKey(SECOND_KEY, () => {
      bFires += 1;
    });

    const aFill = emptySlots();
    aFill[1] = { item: ItemId.Stone, count: 3 };
    chestState.replaceFromWire(DEFAULT_LOC, aFill);

    expect(aFires).toBe(1);
    expect(bFires).toBe(0);
  });

  it("closing one chest leaves the other's drag/drop wiring intact", () => {
    const bFill = emptySlots();
    bFill[3] = { item: ItemId.Gold, count: 5 };
    const { moves, chestState } = mountUis(emptySlots(), emptySlots(), DEFAULT_LOC);
    chestState.replaceFromWire(SECOND_LOC, bFill);
    chestState.closeFromWire(DEFAULT_LOC);

    // Only B's panel remains; its slot 3 holds 5 Gold. Drag it onto
    // the player panel and verify the wire surface still works.
    const survivor = document.querySelector(
      ".anarchy-chest-panel",
    ) as HTMLElement;
    const src = survivor.querySelectorAll(".anarchy-chest-slot")[3] as HTMLDivElement;
    const dst = panelCells()[0];
    dragGesture(src, dst);
    expect(moves).toEqual([
      {
        src: 3,
        dst: HOTBAR_SLOTS,
        srcChestKey: SECOND_KEY,
        dstChestKey: null,
      },
    ]);
  });
});
