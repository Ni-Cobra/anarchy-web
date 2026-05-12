/**
 * Chest-panel manager (tasks 591, 592). Owns per-chest panel DOM nodes
 * keyed by `ChestKey`, mount/unmount lifecycle, header chrome (title +
 * X button), the drag-to-move position state for each panel, plus the
 * focus stack that drives z-order and the "active panel" emphasis.
 *
 * Task 592 lifted the "one panel mounted at a time" cap: opening chest
 * B while A is open mounts B alongside A. Closing A leaves B
 * undisturbed.
 *
 * Layout:
 * - Newly-mounted panels stagger by `STAGGER_PX` in both axes from the
 *   last-mounted panel so a second open doesn't perfectly cover the
 *   first. The stagger wraps inside a coarse viewport window so a long
 *   chain of opens doesn't walk off the screen.
 *
 * Focus / z-order:
 * - A small in-order stack (`focusStack`) tracks recency. The panel at
 *   the top of the stack gets the highest z-index and the `focused`
 *   class for the visual emphasis. Newly-mounted panels open at the
 *   top of the stack; clicking anywhere inside a panel (including the
 *   header on drag-start) raises it.
 */

import {
  type ChestKey,
  type ChestLocation,
  chestKeyOf,
  type Inventory,
  INVENTORY_SIZE,
} from "../../game/index.js";
import { itemDisplayName } from "../../item_names.js";
import { textureUrlForItem } from "../../textures.js";
import type { InventoryUiHandle } from "../inventory/index.js";

const STYLE_ID = "anarchy-chest-style";

/**
 * Header minimum height (CSS px). Used as the keep-on-screen budget for
 * the drag-to-move viewport clamp — at least this many pixels of the
 * header must stay inside the viewport on every axis.
 */
const HEADER_MIN_VISIBLE_PX = 30;

/** Initial panel position (CSS px, top-left, viewport coordinates). */
const INITIAL_X = 280;
const INITIAL_Y = 90;

/**
 * Distance the second-and-subsequent panels are offset from the previous
 * mount. The task spec calls for ~30 px stagger; we wrap the stagger
 * inside a coarse window so a long chain of opens doesn't walk
 * indefinitely off the bottom-right.
 */
const STAGGER_PX = 30;
const STAGGER_WRAP_PX = 8 * STAGGER_PX;

/** Estimated panel footprint. Used by the drag clamp before the panel
 * has laid out (e.g. in unit tests with happy-dom where
 * `getBoundingClientRect` returns zeros). The clamp prefers the live
 * rect when available. */
const ESTIMATED_PANEL_WIDTH = 9 * 48 + 8 * 4 + 16 * 2;

/**
 * z-index baseline applied to chest panels. The focus stack adds the
 * per-panel rank on top so the most-recently-focused panel paints over
 * the others. Stays below the inventory overlay's 8500-band so the
 * hotbar / panel still wins.
 */
const Z_INDEX_BASE = 8400;

const STYLE = `
  #anarchy-chest-root {
    position: fixed;
    inset: 0;
    pointer-events: none;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
  }
  #anarchy-chest-root > * { pointer-events: auto; }
  .anarchy-chest-panel {
    position: fixed;
    left: 0;
    top: 0;
    display: none;
    flex-direction: column;
    background: rgba(20, 24, 30, 0.92);
    border: 1px solid rgba(180, 140, 80, 0.4);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    box-sizing: border-box;
    user-select: none;
  }
  .anarchy-chest-panel.open { display: flex; }
  .anarchy-chest-panel.focused {
    border-color: rgba(220, 180, 110, 0.85);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
  }
  .anarchy-chest-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    min-height: ${HEADER_MIN_VISIBLE_PX}px;
    background: rgba(40, 30, 20, 0.55);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px 7px 0 0;
    cursor: grab;
    box-sizing: border-box;
  }
  .anarchy-chest-header.dragging { cursor: grabbing; }
  .anarchy-chest-title-text {
    font-size: 12px;
    color: #d8c195;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .anarchy-chest-close {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    color: #f0f0f0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    user-select: none;
  }
  .anarchy-chest-close:hover {
    background: rgba(220, 80, 80, 0.5);
    border-color: rgba(255, 120, 120, 0.7);
  }
  .anarchy-chest-grid {
    display: grid;
    grid-template-columns: repeat(9, 48px);
    gap: 4px;
    padding: 16px;
  }
  .anarchy-chest-slot {
    width: 48px;
    height: 48px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    cursor: pointer;
    user-select: none;
    box-sizing: border-box;
  }
  .anarchy-chest-slot:hover { background: rgba(255, 255, 255, 0.10); }
  .anarchy-chest-slot img {
    width: 36px; height: 36px;
    image-rendering: pixelated;
    pointer-events: none;
  }
  .anarchy-chest-slot .count {
    position: absolute;
    bottom: 2px; right: 4px;
    font-size: 11px;
    color: #ffffff;
    text-shadow: 1px 1px 0 #000;
  }
  .anarchy-chest-slot.drag-source { opacity: 0.4; }
  .anarchy-chest-slot.split-source {
    border-color: #ffd34a;
    box-shadow: 0 0 0 2px rgba(255, 211, 74, 0.5) inset;
  }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = STYLE;
  document.head.appendChild(tag);
}

export interface PanelManagerOptions {
  readonly inventoryUi: InventoryUiHandle;
  /** Sent when the user clicks the X button on a panel's header. */
  readonly sendCloseChest: (loc: ChestLocation) => void;
}

interface PanelEntry {
  readonly loc: ChestLocation;
  readonly key: ChestKey;
  readonly panel: HTMLDivElement;
  readonly header: HTMLDivElement;
  readonly cells: HTMLDivElement[];
  position: { x: number; y: number };
  /** Detaches the per-panel window listeners attached during an in-flight drag. */
  detachDrag: () => void;
}

export interface PanelManagerHandle {
  /** Mount the panel for `loc` if not already mounted. Idempotent. */
  mount(loc: ChestLocation): void;
  /** Unmount the panel for `loc` if mounted. */
  unmount(loc: ChestLocation): void;
  /** True iff the panel for `loc` is mounted. */
  has(loc: ChestLocation): boolean;
  /** Render the latest contents into the mounted panel for `loc`. */
  render(loc: ChestLocation, inventory: Inventory): void;
  /** Mounted chestKeys in insertion order. */
  mountedKeys(): readonly ChestKey[];
  /** Mounted chestKeys ordered bottom → top by current z-order. */
  focusOrder(): readonly ChestKey[];
  /** Tear down every panel; keep the manager attached to the DOM. */
  unmountAll(): void;
  /** Tear down every panel and detach the manager root from the DOM. */
  dispose(): void;
}

export function createPanelManager(
  options: PanelManagerOptions,
): PanelManagerHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = "anarchy-chest-root";
  document.body.appendChild(root);

  const entries = new Map<ChestKey, PanelEntry>();
  /**
   * Focus stack ordered bottom → top. The last element wins the highest
   * z-index and the `focused` class. Mutations always go through
   * `raiseToFront` so the rendered z-indices and class stay in sync.
   */
  const focusStack: ChestKey[] = [];
  /**
   * Offset for the next mount, in CSS px. Each new mount writes (and
   * then advances) this counter so successive opens stagger by
   * `STAGGER_PX` without perfectly covering the previous panel.
   */
  let nextStaggerOffset = 0;

  const applyTransform = (entry: PanelEntry): void => {
    entry.panel.style.transform = `translate(${entry.position.x}px, ${entry.position.y}px)`;
  };

  const applyFocusOrder = (): void => {
    for (let i = 0; i < focusStack.length; i++) {
      const entry = entries.get(focusStack[i]);
      if (entry === undefined) continue;
      entry.panel.style.zIndex = String(Z_INDEX_BASE + i);
      entry.panel.classList.toggle("focused", i === focusStack.length - 1);
    }
  };

  const raiseToFront = (key: ChestKey): void => {
    const idx = focusStack.indexOf(key);
    if (idx === focusStack.length - 1) return;
    if (idx >= 0) focusStack.splice(idx, 1);
    focusStack.push(key);
    applyFocusOrder();
  };

  const dropFromStack = (key: ChestKey): void => {
    const idx = focusStack.indexOf(key);
    if (idx < 0) return;
    focusStack.splice(idx, 1);
    applyFocusOrder();
  };

  const clampPosition = (entry: PanelEntry, x: number, y: number): { x: number; y: number } => {
    // Prefer the live rect; fall back to the layout estimate when the
    // panel hasn't laid out yet (e.g. happy-dom in unit tests where
    // `getBoundingClientRect` returns zeros).
    const rect = entry.panel.getBoundingClientRect();
    const panelWidth = rect.width > 0 ? rect.width : ESTIMATED_PANEL_WIDTH;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // The header is the top strip of the panel. Keep at least
    // HEADER_MIN_VISIBLE_PX of it inside the viewport on each axis so
    // the user can always re-grab it. Vertically the top edge can't
    // travel above 0 (else the header is pushed off-screen above) and
    // can't travel below `vh - HEADER_MIN_VISIBLE_PX` (else only the
    // header's top pixel row stays in view).
    const minX = HEADER_MIN_VISIBLE_PX - panelWidth;
    const maxX = vw - HEADER_MIN_VISIBLE_PX;
    const minY = 0;
    const maxY = vh - HEADER_MIN_VISIBLE_PX;

    return {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y)),
    };
  };

  const attachDrag = (entry: PanelEntry): void => {
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragging = false;

    const onPointerMove = (ev: PointerEvent): void => {
      if (!dragging) return;
      const next = clampPosition(
        entry,
        ev.clientX - dragOffsetX,
        ev.clientY - dragOffsetY,
      );
      entry.position = next;
      applyTransform(entry);
    };
    const onPointerUp = (_ev: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      entry.header.classList.remove("dragging");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    entry.header.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // The X button stops its own pointerdown so we never reach here
      // for it. Defensively confirm we're on the header proper before
      // arming a drag.
      const target = ev.target;
      if (target instanceof HTMLElement && target.closest(".anarchy-chest-close") !== null) {
        return;
      }
      ev.preventDefault();
      raiseToFront(entry.key);
      dragOffsetX = ev.clientX - entry.position.x;
      dragOffsetY = ev.clientY - entry.position.y;
      dragging = true;
      entry.header.classList.add("dragging");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    });

    entry.detachDrag = (): void => {
      if (dragging) {
        dragging = false;
        entry.header.classList.remove("dragging");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      }
    };
  };

  const initialPosition = (): { x: number; y: number } => {
    const offset = nextStaggerOffset;
    nextStaggerOffset = (nextStaggerOffset + STAGGER_PX) % STAGGER_WRAP_PX;
    return { x: INITIAL_X + offset, y: INITIAL_Y + offset };
  };

  const buildPanel = (loc: ChestLocation): PanelEntry => {
    const key = chestKeyOf(loc);

    const panel = document.createElement("div");
    panel.className = "anarchy-chest-panel open";

    const header = document.createElement("div");
    header.className = "anarchy-chest-header";

    const titleText = document.createElement("div");
    titleText.className = "anarchy-chest-title-text";
    titleText.textContent = "Chest";
    header.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "anarchy-chest-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close chest");
    closeBtn.textContent = "X";
    // Stop pointerdown bubbling to the header so a click on X never
    // arms the drag gesture.
    closeBtn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      options.sendCloseChest(loc);
    });
    header.appendChild(closeBtn);

    panel.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "anarchy-chest-grid";
    const cells: HTMLDivElement[] = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const cell = document.createElement("div");
      cell.className = "anarchy-chest-slot";
      // Suppress the browser context menu so right-click can drive the
      // split flow without the OS overlay stealing focus. Pointerdown is
      // owned by the dragdrop state machine via `wireChestSlot`.
      cell.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      options.inventoryUi.wireChestSlot(key, i, cell);
      grid.appendChild(cell);
      cells.push(cell);
    }
    panel.appendChild(grid);

    // Any pointer landing in the panel (cell or chrome) raises focus.
    // Bound on capture so the cells' own pointerdown listeners still
    // run normally — this handler only mutates focus state.
    panel.addEventListener(
      "pointerdown",
      () => {
        raiseToFront(key);
      },
      true,
    );

    // Stop pointer events from reaching `window` so the bootstrap-level
    // mousedown / contextmenu handlers don't fire destroy / place when
    // a click lands on the chest panel.
    for (const ev of ["mousedown", "mouseup", "click"] as const) {
      panel.addEventListener(ev, (e) => e.stopPropagation());
    }
    panel.addEventListener("contextmenu", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    const entry: PanelEntry = {
      loc,
      key,
      panel,
      header,
      cells,
      position: initialPosition(),
      detachDrag: () => {},
    };
    applyTransform(entry);
    attachDrag(entry);
    return entry;
  };

  const renderEntry = (entry: PanelEntry, inv: Inventory): void => {
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const cell = entry.cells[i];
      const slot = inv.slot(i);
      cell.replaceChildren();
      cell.title = "";
      if (slot === null) continue;
      const url = textureUrlForItem(slot.item);
      if (url !== null) {
        const img = document.createElement("img");
        img.src = url;
        cell.appendChild(img);
      }
      if (slot.count > 1) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(slot.count);
        cell.appendChild(count);
      }
      const name = itemDisplayName(slot.item);
      cell.title = slot.count > 1 ? `${name} (${slot.count})` : name;
    }
  };

  const mount = (loc: ChestLocation): void => {
    const key = chestKeyOf(loc);
    if (entries.has(key)) return;
    const entry = buildPanel(loc);
    entries.set(key, entry);
    root.appendChild(entry.panel);
    focusStack.push(key);
    applyFocusOrder();
  };

  const unmount = (loc: ChestLocation): void => {
    const key = chestKeyOf(loc);
    const entry = entries.get(key);
    if (entry === undefined) return;
    entry.detachDrag();
    options.inventoryUi.unwireChestKey(key);
    entry.panel.remove();
    entries.delete(key);
    dropFromStack(key);
  };

  return {
    mount,
    unmount,
    has: (loc) => entries.has(chestKeyOf(loc)),
    render: (loc, inv) => {
      const entry = entries.get(chestKeyOf(loc));
      if (entry === undefined) return;
      renderEntry(entry, inv);
    },
    mountedKeys: () => Array.from(entries.keys()),
    focusOrder: () => focusStack.slice(),
    unmountAll: () => {
      for (const entry of entries.values()) {
        entry.detachDrag();
        options.inventoryUi.unwireChestKey(entry.key);
        entry.panel.remove();
      }
      entries.clear();
      focusStack.length = 0;
    },
    dispose: () => {
      for (const entry of entries.values()) {
        entry.detachDrag();
        options.inventoryUi.unwireChestKey(entry.key);
        entry.panel.remove();
      }
      entries.clear();
      focusStack.length = 0;
      root.remove();
    },
  };
}
