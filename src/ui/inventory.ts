/**
 * Inventory overlay: a fixed bottom-center hotbar (always visible) and a
 * left-side sliding panel that exposes the main grid (slots
 * `HOTBAR_SLOTS..INVENTORY_SIZE`).
 *
 * Network-free: the module reads inventory state through a `getInventory`
 * thunk passed in by `bootstrap.ts` and subscribes to the live `Inventory`
 * mirror so each `InventoryUpdate` from the server triggers a re-render.
 * Slot icons are placeholder colored squares per `ItemId` — `INVENTORY_PALETTE`
 * is the small CSS-color map. Real textures land later.
 *
 * Selection state (the highlighted hotbar cell) is mirrored locally so the
 * UI can repaint without a server round-trip; the wire-driven `sendSelect`
 * callback ships the authoritative update (the server is the source of
 * truth — see `Player::selected_hotbar_slot` in the server crate). The UI
 * also owns the drag preview for slot moves; on drop, `sendMove(src, dst)`
 * is called and the mirror waits for the next `InventoryUpdate` to
 * reflect the result (no optimistic update — the UI is a pure mirror).
 *
 * Click handling mirrors `side_panel.ts`: pointer events on the panel /
 * hotbar root are stopped from propagating to `window` so the bootstrap-
 * level mousedown handlers don't fire destroy / place behind the overlay.
 * The panel does NOT capture clicks outside its DOM bounds — the player
 * can keep playing while the inventory is open.
 */

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  type Inventory,
  ItemId,
  MAIN_SLOTS,
  type Slot,
} from "../game/index.js";

const STYLE_ID = "anarchy-inventory-style";

const SLOT_PX = 48;
const HOTBAR_GAP_PX = 4;
const PANEL_PAD_PX = 16;
const PANEL_GAP_PX = 4;
const PANEL_COLS = HOTBAR_SLOTS;
const PANEL_WIDTH_PX =
  PANEL_COLS * SLOT_PX + (PANEL_COLS - 1) * PANEL_GAP_PX + PANEL_PAD_PX * 2;

/**
 * Placeholder slot colors per item kind. `ItemId.<X>` enum values are the
 * keys; lookup falls back to a neutral gray for any unknown id (no UI for
 * that id today, but defensive).
 */
const INVENTORY_PALETTE: Record<ItemId, string> = {
  [ItemId.Stick]: "#a8732a",
  [ItemId.Wood]: "#5e3a1a",
  [ItemId.Stone]: "#7d8590",
  [ItemId.Gold]: "#f5c542",
};

const STYLE = `
  #anarchy-inventory-root {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 8500;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
  }
  #anarchy-inventory-root > * { pointer-events: auto; }
  .anarchy-hotbar {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: ${HOTBAR_GAP_PX}px;
    padding: 6px;
    background: rgba(20, 24, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .anarchy-inventory-panel {
    position: absolute;
    top: 50%;
    left: 0;
    transform: translate(-100%, -50%);
    transition: transform 0.15s ease-out;
    width: ${PANEL_WIDTH_PX}px;
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-left: none;
    border-radius: 0 8px 8px 0;
    box-shadow: 8px 0 24px rgba(0, 0, 0, 0.4);
    box-sizing: border-box;
    padding: ${PANEL_PAD_PX}px;
    display: grid;
    grid-template-columns: repeat(${PANEL_COLS}, ${SLOT_PX}px);
    gap: ${PANEL_GAP_PX}px;
  }
  .anarchy-inventory-panel.open { transform: translate(0, -50%); }
  .anarchy-inventory-slot {
    width: ${SLOT_PX}px;
    height: ${SLOT_PX}px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    box-sizing: border-box;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .anarchy-inventory-slot.selected {
    border-color: #ffffff;
    box-shadow: 0 0 0 2px #5aa0ff inset;
  }
  .anarchy-inventory-icon {
    width: 70%;
    height: 70%;
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .anarchy-inventory-count {
    position: absolute;
    bottom: 2px;
    right: 4px;
    font-size: 12px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    pointer-events: none;
  }
  .anarchy-inventory-slot.drag-source { opacity: 0.4; }
  .anarchy-inventory-drag-preview {
    position: fixed;
    width: ${SLOT_PX}px;
    height: ${SLOT_PX}px;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 9000;
    background: rgba(20, 24, 30, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: 4px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export interface InventoryUiOptions {
  /** Reads the current inventory mirror. Called on every render. */
  readonly getInventory: () => Inventory;
  /**
   * Ship a `SelectSlot` action up to the server. Called by the keymap +
   * wheel hooks any time the local selection changes; the local mirror
   * updates immediately so the highlight is responsive, and the next
   * server `InventoryUpdate` is the authoritative correction (today the
   * server doesn't echo selection back, but the action is still
   * authoritatively applied per place validation).
   */
  readonly sendSelect: (slot: number) => void;
  /** Ship a `MoveSlot` drag-drop action up to the server. */
  readonly sendMove: (src: number, dst: number) => void;
}

export interface InventoryUiHandle {
  isOpen(): boolean;
  setOpen(open: boolean): void;
  toggle(): void;
  /** Index of the highlighted hotbar slot. Default 0. */
  selectedHotbarSlot(): number;
  /**
   * Locally mirror a hotbar selection change (also ships the action via
   * `sendSelect`). Called by `bootstrap.ts`'s number-key + wheel handlers.
   */
  selectHotbarSlot(slot: number): void;
  /** Force a re-render — exposed for tests; the live mirror notifies on its own. */
  render(): void;
  unmount(): void;
}

/**
 * Mount the inventory overlay. Returns a handle whose `unmount()` removes
 * all DOM and listeners, used by `runMain`'s teardown.
 */
export function mountInventoryUi(
  options: InventoryUiOptions,
): InventoryUiHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = "anarchy-inventory-root";

  const hotbar = document.createElement("div");
  hotbar.className = "anarchy-hotbar";
  hotbar.setAttribute("role", "toolbar");
  hotbar.setAttribute("aria-label", "Hotbar");
  root.appendChild(hotbar);

  const panel = document.createElement("aside");
  panel.className = "anarchy-inventory-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Inventory");
  root.appendChild(panel);

  const hotbarCells: HTMLDivElement[] = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const cell = makeSlotCell();
    hotbar.appendChild(cell);
    hotbarCells.push(cell);
  }

  const panelCells: HTMLDivElement[] = [];
  for (let i = 0; i < MAIN_SLOTS; i++) {
    const cell = makeSlotCell();
    panel.appendChild(cell);
    panelCells.push(cell);
  }

  let open = false;
  let selectedSlot = 0;

  // Drag state: the slot index the pointer-down landed on plus a floating
  // preview element that follows the cursor until release. `null` outside
  // of an active drag.
  let dragSrc: number | null = null;
  let dragPreview: HTMLDivElement | null = null;

  const cellByIndex = (idx: number): HTMLDivElement | null => {
    if (idx < 0 || idx >= INVENTORY_SIZE) return null;
    if (idx < HOTBAR_SLOTS) return hotbarCells[idx];
    return panelCells[idx - HOTBAR_SLOTS];
  };

  const slotIndexFromCell = (cell: HTMLElement): number | null => {
    const hotbarIdx = hotbarCells.indexOf(cell as HTMLDivElement);
    if (hotbarIdx >= 0) return hotbarIdx;
    const panelIdx = panelCells.indexOf(cell as HTMLDivElement);
    if (panelIdx >= 0) return HOTBAR_SLOTS + panelIdx;
    return null;
  };

  const render = (): void => {
    const inv = options.getInventory();
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      paintSlot(hotbarCells[i], inv.slot(i), i === selectedSlot);
    }
    for (let i = 0; i < MAIN_SLOTS; i++) {
      paintSlot(panelCells[i], inv.slot(HOTBAR_SLOTS + i), false);
    }
  };

  const beginDrag = (src: number, ev: PointerEvent): void => {
    const inv = options.getInventory();
    const slot = inv.slot(src);
    if (slot === null) return;
    dragSrc = src;
    cellByIndex(src)?.classList.add("drag-source");
    const preview = document.createElement("div");
    preview.className = "anarchy-inventory-drag-preview";
    const icon = document.createElement("div");
    icon.className = "anarchy-inventory-icon";
    icon.style.background = INVENTORY_PALETTE[slot.item] ?? "#888";
    preview.appendChild(icon);
    if (slot.count > 1) {
      const count = document.createElement("span");
      count.className = "anarchy-inventory-count";
      count.textContent = String(slot.count);
      preview.appendChild(count);
    }
    preview.style.left = `${ev.clientX}px`;
    preview.style.top = `${ev.clientY}px`;
    document.body.appendChild(preview);
    dragPreview = preview;
  };

  const cancelDrag = (): void => {
    if (dragSrc !== null) {
      cellByIndex(dragSrc)?.classList.remove("drag-source");
    }
    dragSrc = null;
    if (dragPreview !== null) {
      dragPreview.remove();
      dragPreview = null;
    }
  };

  // Pointer-down on a slot starts a drag. The matching `pointerup`
  // listener at the document level resolves the drop target.
  const wireSlotPointerDown = (idx: number, cell: HTMLDivElement): void => {
    cell.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      beginDrag(idx, ev);
    });
  };
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    wireSlotPointerDown(i, hotbarCells[i]);
  }
  for (let i = 0; i < MAIN_SLOTS; i++) {
    wireSlotPointerDown(HOTBAR_SLOTS + i, panelCells[i]);
  }

  // Cursor follow + drop resolution at document level so a drag that
  // releases outside any slot cancels cleanly.
  const onDocumentPointerMove = (ev: PointerEvent): void => {
    if (dragPreview === null) return;
    dragPreview.style.left = `${ev.clientX}px`;
    dragPreview.style.top = `${ev.clientY}px`;
  };
  document.addEventListener("pointermove", onDocumentPointerMove);

  const onDocumentPointerUp = (ev: PointerEvent): void => {
    if (dragSrc === null) return;
    const src = dragSrc;
    cancelDrag();
    const targets = document.elementsFromPoint(ev.clientX, ev.clientY);
    let dst: number | null = null;
    for (const t of targets) {
      if (t instanceof HTMLElement && t.classList.contains("anarchy-inventory-slot")) {
        dst = slotIndexFromCell(t);
        if (dst !== null) break;
      }
    }
    if (dst === null || dst === src) return;
    options.sendMove(src, dst);
  };
  document.addEventListener("pointerup", onDocumentPointerUp);

  // Escape during a drag aborts cleanly — no `sendMove` fires and the
  // preview / drag-source highlight clears. Listener is captured so a
  // game-side keydown handler can't preempt it.
  const onDocumentKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    if (dragSrc === null) return;
    cancelDrag();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  // Hotbar click → select. Bound on `click` (vs. pointerdown) so a drag
  // gesture starting on a hotbar cell doesn't also flip selection on the
  // way down — `click` doesn't fire when the pointer-down + pointer-up
  // pair didn't land on the same element (the drag preview floats away
  // from the source).
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const idx = i;
    hotbarCells[i].addEventListener("click", () => {
      if (idx === selectedSlot) return;
      selectedSlot = idx;
      options.sendSelect(idx);
      render();
    });
  }

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    panel.classList.toggle("open", open);
  };

  const selectHotbarSlot = (slot: number): void => {
    if (slot < 0 || slot >= HOTBAR_SLOTS) return;
    if (slot === selectedSlot) return;
    selectedSlot = slot;
    options.sendSelect(slot);
    render();
  };

  const unsubscribe = options.getInventory().subscribe(render);

  // Stop pointer events from reaching `window` so the bootstrap-level
  // mousedown / contextmenu handlers don't fire destroy / place when a
  // click lands on the hotbar or the panel.
  for (const ev of ["mousedown", "mouseup", "click", "contextmenu"] as const) {
    hotbar.addEventListener(ev, (e) => e.stopPropagation());
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }

  document.body.appendChild(root);
  render();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    selectedHotbarSlot: () => selectedSlot,
    selectHotbarSlot,
    render,
    unmount: () => {
      unsubscribe();
      document.removeEventListener("pointermove", onDocumentPointerMove);
      document.removeEventListener("pointerup", onDocumentPointerUp);
      document.removeEventListener("keydown", onDocumentKeydown, true);
      cancelDrag();
      root.remove();
    },
  };
}

function makeSlotCell(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "anarchy-inventory-slot";
  return el;
}

function paintSlot(
  cell: HTMLDivElement,
  slot: Slot,
  selected: boolean,
): void {
  cell.classList.toggle("selected", selected);
  cell.replaceChildren();
  if (slot === null) return;
  const icon = document.createElement("div");
  icon.className = "anarchy-inventory-icon";
  icon.style.background = INVENTORY_PALETTE[slot.item] ?? "#888";
  cell.appendChild(icon);
  if (slot.count > 1) {
    const count = document.createElement("span");
    count.className = "anarchy-inventory-count";
    count.textContent = String(slot.count);
    cell.appendChild(count);
  }
}
