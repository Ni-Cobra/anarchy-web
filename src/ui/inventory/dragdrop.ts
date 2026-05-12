/**
 * Pointer state machine for inventory cells: pending click vs. promoted
 * drag, plus the drop dispatcher that routes a release to the right wire
 * action (`MoveSlot` / `EquipTool` / `UnequipTool`), AND the right-click
 * split state machine that arms a "source" cell on right-click and ramps
 * a per-tick `TransferItems(src, dst, 1)` while right-mouse is held over
 * a destination.
 *
 * Cells live in one of two grids: the player's own inventory
 * (`kind: "player"`) or an open chest's inventory (`kind: "chest"`,
 * carrying a `chestKey` so the same machinery is ready to address N
 * panels — task 591). Each registered cell carries a `SlotRef` so the
 * state machine can route `MoveSlot` / `TransferItems` with the cross-grid
 * `chestKey` filled in. Equipment sentinels are player-only and use
 * negative `idx` values.
 *
 * Every cell that should participate has its pointerdown wired via
 * [`attachDragDrop`]'s returned `wireSlotPointerDown`. Document-level
 * pointermove / pointerup / keydown(Escape) listeners drive promotion +
 * drop + abort and unwind via the returned `detach`.
 *
 * Routing matrix for a completed drop (src → dst):
 * - regular → regular     : `sendMove` (`MoveSlot` with chest keys
 *                            derived from the refs — same-grid or cross-
 *                            grid)
 * - regular → equipment   : `sendEquip` if kind matches AND the source
 *                            is a player cell; chest → equipment is
 *                            rejected (no wire surface for equipping
 *                            from a chest)
 * - equipment → regular   : `sendUnequip` if dst is a player cell;
 *                            equipment → chest is rejected (server picks
 *                            the destination on unequip)
 * - equipment → equipment : silently dropped
 *
 * Right-click split (regular cells only — equipment slots ignore right-
 * click):
 * - First right-click on a non-empty cell **arms** that cell as the
 *   split source (sticky `.split-source` border). Source can be in
 *   either grid.
 * - With a source armed, right-clicking a different regular cell
 *   **starts a hold transfer** toward that cell — first frame fires
 *   immediately, then the timer ramps from a slow tick (~500 ms) to a
 *   fast tick (~100 ms) over `RAMP_END_MS`. Cross-grid transfers carry
 *   the chest keys.
 * - Right-click release stops the timer; the source stays armed.
 * - Any left-click clears the source.
 */

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  type Inventory,
  ItemId,
  toolKindOf,
  type ToolKind,
} from "../../game/index.js";
import type { ChestKey } from "../chest/chest_key.js";
import { applyItemIconStyle } from "./cells.js";

/**
 * Tag that identifies a cell as belonging to either the player's own
 * inventory or to an open chest's inventory (task 591 discriminated
 * union shape). Equipment sentinels are player-only with negative `idx`.
 */
export type SlotRef =
  | { readonly kind: "player"; readonly idx: number }
  | { readonly kind: "chest"; readonly chestKey: ChestKey; readonly idx: number };

export function playerSlotRef(idx: number): SlotRef {
  return { kind: "player", idx };
}

export function chestSlotRef(chestKey: ChestKey, idx: number): SlotRef {
  return { kind: "chest", chestKey, idx };
}

export function slotRefEqual(a: SlotRef | null, b: SlotRef | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.idx !== b.idx) return false;
  if (a.kind === "chest" && b.kind === "chest") {
    return a.chestKey === b.chestKey;
  }
  return true;
}

/**
 * Sentinel slot indices used by the drag-and-drop machinery to identify
 * the equipment slots. Outside `[0, INVENTORY_SIZE)` so the wire
 * `MoveSlot` path can never confuse them with a real slot index — the
 * UI translates the sentinels into `EquipTool` / `UnequipTool` actions
 * before sending.
 */
export const EQUIP_PICKAXE_SLOT_ID = -1;
export const EQUIP_AXE_SLOT_ID = -2;
export const EQUIP_UTILITY_SLOT_ID = -3;
export const EQUIP_SHOVEL_SLOT_ID = -4;

/**
 * Squared cursor-movement threshold (in CSS pixels) that flips a
 * pointer-down into a drag instead of a click.
 */
const DRAG_THRESHOLD_PX_SQ = 25;

/** Right-click hold transfer pacing. */
const SPLIT_SLOW_INTERVAL_MS = 500;
const SPLIT_FAST_INTERVAL_MS = 100;
const SPLIT_RAMP_END_MS = 2000;

function splitIntervalForElapsed(elapsedMs: number): number {
  if (elapsedMs >= SPLIT_RAMP_END_MS) return SPLIT_FAST_INTERVAL_MS;
  const t = elapsedMs / SPLIT_RAMP_END_MS;
  return Math.round(
    SPLIT_SLOW_INTERVAL_MS + (SPLIT_FAST_INTERVAL_MS - SPLIT_SLOW_INTERVAL_MS) * t,
  );
}

export function equipKindForSentinel(idx: number): ToolKind | null {
  if (idx === EQUIP_PICKAXE_SLOT_ID) return "pickaxe";
  if (idx === EQUIP_AXE_SLOT_ID) return "axe";
  if (idx === EQUIP_UTILITY_SLOT_ID) return "utility";
  if (idx === EQUIP_SHOVEL_SLOT_ID) return "shovel";
  return null;
}

export interface DragDropContext {
  /** Player's inventory mirror. */
  getInventory: () => Inventory;
  /**
   * Open chest's inventory mirror for a given `chestKey`, or `null` if
   * no chest with that key is currently open. Used for the drag-preview
   * count badge when the source is a chest cell and for the chest-cell
   * click-to-withdraw path.
   */
  getChestInventory: (chestKey: ChestKey) => Inventory | null;
  /** Read the currently-highlighted hotbar slot for click-into-hand. */
  getSelectedHotbarSlot: () => number;
  /**
   * Ship a `MoveSlot` drag-drop action up to the server. Both refs carry
   * their cross-grid `chestKey` so the same wire action covers same-grid
   * and cross-grid moves uniformly.
   */
  sendMove: (src: SlotRef, dst: SlotRef) => void;
  /** Ship a `TransferItems(src, dst, count)` action. */
  sendTransfer: (src: SlotRef, dst: SlotRef, count: number) => void;
  sendEquip: (sourceSlot: number, kind: ToolKind) => void;
  sendUnequip: (kind: ToolKind) => void;
}

export interface DragDropHandle {
  /**
   * Wire pointer-down on `cell` so it opens a pending gesture for the
   * given slot ref. Promotion to a drag happens at the document level.
   * Equipment sentinels MUST use the corresponding negative `idx` with
   * `kind: "player"`.
   */
  wireSlotPointerDown: (ref: SlotRef, cell: HTMLDivElement) => void;
  /**
   * Drop a previously-wired chest cell from the registry. Called by the
   * chest panel manager when a panel unmounts so its DOM nodes can be
   * garbage-collected and the chestKey freed for future remounts.
   */
  unwireChestKey: (chestKey: ChestKey) => void;
  /** Reconcile right-click split source state after a paint pass. */
  refreshSplitSource: () => void;
  detach: () => void;
}

/**
 * Install the pointer state machine. Returns per-cell wiring + a `detach`
 * that removes every document-level listener registered here.
 */
export function attachDragDrop(ctx: DragDropContext): DragDropHandle {
  // Cell registry. `playerCells` carries player slots (hotbar + panel)
  // and equipment sentinels (sparse, equipment uses negative keys).
  // `chestCellsByKey` carries one inner map per open chest, keyed by the
  // chest's `chestKey`. Both are unwound in `unwireChestKey` / `detach`
  // so a remount can reuse the same chestKey safely.
  const playerCells = new Map<number, HTMLDivElement>();
  const chestCellsByKey = new Map<ChestKey, Map<number, HTMLDivElement>>();
  // Reverse lookup so the document-level drop resolver can map a DOM
  // cell back to its slot ref in O(1).
  const refByCell = new WeakMap<HTMLDivElement, SlotRef>();

  const cellAt = (ref: SlotRef): HTMLDivElement | null => {
    if (ref.kind === "player") return playerCells.get(ref.idx) ?? null;
    return chestCellsByKey.get(ref.chestKey)?.get(ref.idx) ?? null;
  };

  // Read the item at a slot ref. Equipment sentinels resolve via
  // `Inventory.getEquipped`; player slots via `Inventory.slot`; chest
  // slots via the chest's inventory mirror (or null if no chest with
  // that key is currently open).
  const itemAt = (ref: SlotRef): ItemId | null => {
    if (ref.kind === "chest") {
      const inv = ctx.getChestInventory(ref.chestKey);
      return inv?.slot(ref.idx)?.item ?? null;
    }
    const kind = equipKindForSentinel(ref.idx);
    const inv = ctx.getInventory();
    if (kind !== null) return inv.getEquipped(kind);
    return inv.slot(ref.idx)?.item ?? null;
  };

  // Pending-gesture state: pointer-down landed on `pointerSrc` at
  // `pointerStart`. Promotion to drag happens once movement exceeds
  // threshold.
  let pointerSrc: SlotRef | null = null;
  let pointerStart: { x: number; y: number } | null = null;
  let dragSrc: SlotRef | null = null;
  let dragPreview: HTMLDivElement | null = null;

  const beginDrag = (src: SlotRef, ev: PointerEvent): void => {
    const item = itemAt(src);
    if (item === null) return;
    dragSrc = src;
    cellAt(src)?.classList.add("drag-source");
    const preview = document.createElement("div");
    preview.className = "anarchy-inventory-drag-preview";
    const icon = document.createElement("div");
    icon.className = "anarchy-inventory-icon";
    applyItemIconStyle(icon, { item, count: 1 });
    preview.appendChild(icon);
    // Equipment slots hold count-1 tools so we never paint a count
    // badge for a drag preview originating there. Regular cells read
    // the stack count from the matching inventory mirror.
    if (src.kind === "player" && equipKindForSentinel(src.idx) === null) {
      const inv = ctx.getInventory();
      const slot = inv.slot(src.idx);
      if (slot !== null && slot.count > 1) {
        const count = document.createElement("span");
        count.className = "anarchy-inventory-count";
        count.textContent = String(slot.count);
        preview.appendChild(count);
      }
    } else if (src.kind === "chest") {
      const inv = ctx.getChestInventory(src.chestKey);
      const slot = inv?.slot(src.idx) ?? null;
      if (slot !== null && slot.count > 1) {
        const count = document.createElement("span");
        count.className = "anarchy-inventory-count";
        count.textContent = String(slot.count);
        preview.appendChild(count);
      }
    }
    preview.style.left = `${ev.clientX}px`;
    preview.style.top = `${ev.clientY}px`;
    document.body.appendChild(preview);
    dragPreview = preview;
  };

  const cancelDrag = (): void => {
    if (dragSrc !== null) {
      cellAt(dragSrc)?.classList.remove("drag-source");
    }
    dragSrc = null;
    if (dragPreview !== null) {
      dragPreview.remove();
      dragPreview = null;
    }
  };

  // Drop resolver. See routing matrix in the module docstring.
  const handleDrop = (src: SlotRef, dst: SlotRef): void => {
    const srcKind = src.kind === "player" ? equipKindForSentinel(src.idx) : null;
    const dstKind = dst.kind === "player" ? equipKindForSentinel(dst.idx) : null;

    if (srcKind !== null && dstKind !== null) {
      return;
    }
    if (srcKind === null && dstKind !== null) {
      // Regular → equipment. Equipment only exists in the player grid;
      // dragging a chest item directly onto an equipment slot has no
      // wire surface today.
      if (src.kind === "chest") return;
      const inv = ctx.getInventory();
      const stack = inv.slot(src.idx);
      if (stack === null) return;
      if (toolKindOf(stack.item) !== dstKind) return;
      ctx.sendEquip(src.idx, dstKind);
      return;
    }
    if (srcKind !== null && dstKind === null) {
      // Equipment → regular. Server picks the destination on unequip;
      // dragging into a chest grid would not respect intent.
      if (dst.kind === "chest") return;
      ctx.sendUnequip(srcKind);
      return;
    }
    ctx.sendMove(src, dst);
  };

  // Right-click split state.
  let splitSource: SlotRef | null = null;
  let splitTimer: ReturnType<typeof setInterval> | null = null;
  let splitTimerStartedAt = 0;
  let splitTimerDest: SlotRef | null = null;

  const setSplitSourceClass = (
    prev: SlotRef | null,
    next: SlotRef | null,
  ): void => {
    if (prev !== null) cellAt(prev)?.classList.remove("split-source");
    if (next !== null) cellAt(next)?.classList.add("split-source");
  };

  const stopSplitTimer = (): void => {
    if (splitTimer !== null) {
      clearInterval(splitTimer);
      splitTimer = null;
    }
    splitTimerDest = null;
  };

  const clearSplitSource = (): void => {
    stopSplitTimer();
    if (splitSource !== null) {
      setSplitSourceClass(splitSource, null);
      splitSource = null;
    }
  };

  /** Right-click on `ref`: arm split source or start hold-transfer. */
  const beginSplitGesture = (ref: SlotRef): void => {
    if (ref.kind === "player" && equipKindForSentinel(ref.idx) !== null) return;
    if (splitSource === null) {
      if (itemAt(ref) === null) return;
      splitSource = ref;
      setSplitSourceClass(null, ref);
      return;
    }
    if (slotRefEqual(ref, splitSource)) {
      clearSplitSource();
      return;
    }
    const src = splitSource;
    stopSplitTimer();
    splitTimerDest = ref;
    splitTimerStartedAt = performance.now();
    ctx.sendTransfer(src, ref, 1);
    const tickFn = (): void => {
      const dst = splitTimerDest;
      if (dst === null || splitSource === null) {
        stopSplitTimer();
        return;
      }
      ctx.sendTransfer(splitSource, dst, 1);
      const elapsed = performance.now() - splitTimerStartedAt;
      const next = splitIntervalForElapsed(elapsed);
      if (splitTimer !== null) clearInterval(splitTimer);
      splitTimer = setInterval(tickFn, next);
    };
    splitTimer = setInterval(tickFn, splitIntervalForElapsed(0));
  };

  const wireSlotPointerDown = (ref: SlotRef, cell: HTMLDivElement): void => {
    if (ref.kind === "player") {
      playerCells.set(ref.idx, cell);
    } else {
      let inner = chestCellsByKey.get(ref.chestKey);
      if (inner === undefined) {
        inner = new Map();
        chestCellsByKey.set(ref.chestKey, inner);
      }
      inner.set(ref.idx, cell);
    }
    refByCell.set(cell, ref);
    cell.addEventListener("pointerdown", (ev) => {
      if (ev.button === 2) {
        ev.preventDefault();
        beginSplitGesture(ref);
        return;
      }
      if (ev.button !== 0) return;
      ev.preventDefault();
      clearSplitSource();
      pointerSrc = ref;
      pointerStart = { x: ev.clientX, y: ev.clientY };
    });
  };

  const unwireChestKey = (chestKey: ChestKey): void => {
    // If a gesture or split source is anchored to this chest, drop it
    // — the cell is about to be removed from the DOM, so the highlight
    // / preview would dangle.
    if (dragSrc !== null && dragSrc.kind === "chest" && dragSrc.chestKey === chestKey) {
      cancelDrag();
    }
    if (pointerSrc !== null && pointerSrc.kind === "chest" && pointerSrc.chestKey === chestKey) {
      pointerSrc = null;
      pointerStart = null;
    }
    if (splitSource !== null && splitSource.kind === "chest" && splitSource.chestKey === chestKey) {
      clearSplitSource();
    } else if (splitTimerDest !== null && splitTimerDest.kind === "chest" && splitTimerDest.chestKey === chestKey) {
      stopSplitTimer();
    }
    chestCellsByKey.delete(chestKey);
  };

  // Document-level left-click pointerdown clears a sticky split source
  // when the click landed outside any inventory cell.
  const onDocumentPointerDownLeft = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    if (splitSource === null) return;
    const target = ev.target;
    if (
      target instanceof HTMLElement &&
      (target.closest(".anarchy-inventory-slot") !== null ||
        target.closest(".anarchy-chest-slot") !== null)
    ) {
      return;
    }
    clearSplitSource();
  };
  document.addEventListener("pointerdown", onDocumentPointerDownLeft);

  // Cursor follow + drag promotion + drop resolution at document level
  // so a drag that releases outside any slot cancels cleanly.
  const onDocumentPointerMove = (ev: PointerEvent): void => {
    if (pointerSrc !== null && dragSrc === null && pointerStart !== null) {
      const dx = ev.clientX - pointerStart.x;
      const dy = ev.clientY - pointerStart.y;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX_SQ) {
        beginDrag(pointerSrc, ev);
        pointerSrc = null;
        pointerStart = null;
      }
    }
    if (dragPreview === null) return;
    dragPreview.style.left = `${ev.clientX}px`;
    dragPreview.style.top = `${ev.clientY}px`;
  };
  document.addEventListener("pointermove", onDocumentPointerMove);

  const refFromCell = (cell: HTMLElement): SlotRef | null => {
    if (!(cell instanceof HTMLDivElement)) return null;
    return refByCell.get(cell) ?? null;
  };

  const resolveDestRef = (clientX: number, clientY: number): SlotRef | null => {
    const targets = document.elementsFromPoint(clientX, clientY);
    for (const t of targets) {
      if (!(t instanceof HTMLElement)) continue;
      if (
        !t.classList.contains("anarchy-inventory-slot") &&
        !t.classList.contains("anarchy-chest-slot")
      ) {
        continue;
      }
      const ref = refFromCell(t);
      if (ref !== null) return ref;
    }
    return null;
  };

  // Click-to-withdraw destination for a chest cell.
  const findPlayerWithdrawDestination = (): SlotRef | null => {
    const inv = ctx.getInventory();
    for (let i = HOTBAR_SLOTS; i < INVENTORY_SIZE; i++) {
      if (inv.slot(i) === null) return { kind: "player", idx: i };
    }
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      if (inv.slot(i) === null) return { kind: "player", idx: i };
    }
    return null;
  };

  const onDocumentPointerUp = (ev: PointerEvent): void => {
    if (ev.button === 2) {
      stopSplitTimer();
      return;
    }
    const clickSrc = pointerSrc;
    pointerSrc = null;
    pointerStart = null;

    if (dragSrc !== null) {
      const src = dragSrc;
      cancelDrag();
      const dst = resolveDestRef(ev.clientX, ev.clientY);
      if (dst === null || slotRefEqual(src, dst)) return;
      handleDrop(src, dst);
      return;
    }

    if (clickSrc === null) return;
    if (clickSrc.kind === "player" && clickSrc.idx < 0) return;

    if (clickSrc.kind === "chest") {
      const inv = ctx.getChestInventory(clickSrc.chestKey);
      if (inv === null || inv.slot(clickSrc.idx) === null) return;
      const dst = findPlayerWithdrawDestination();
      if (dst === null) return;
      ctx.sendMove(clickSrc, dst);
      return;
    }

    // Player-grid click on a panel cell (hotbar owns its own click).
    if (clickSrc.idx < HOTBAR_SLOTS) return;
    const inv = ctx.getInventory();
    const stack = inv.slot(clickSrc.idx);
    const tool = stack !== null ? toolKindOf(stack.item) : null;
    if (tool !== null) {
      if (inv.getEquippedSlot(tool) === clickSrc.idx) {
        ctx.sendUnequip(tool);
      } else {
        ctx.sendEquip(clickSrc.idx, tool);
      }
      return;
    }
    const dstIdx = ctx.getSelectedHotbarSlot();
    if (stack === null && inv.slot(dstIdx) === null) return;
    ctx.sendMove(clickSrc, { kind: "player", idx: dstIdx });
  };
  document.addEventListener("pointerup", onDocumentPointerUp);

  const onDocumentKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    if (dragSrc === null && pointerSrc === null && splitSource === null) return;
    pointerSrc = null;
    pointerStart = null;
    cancelDrag();
    clearSplitSource();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  const refreshSplitSource = (): void => {
    if (splitSource === null) return;
    if (itemAt(splitSource) === null) {
      clearSplitSource();
      return;
    }
    setSplitSourceClass(null, splitSource);
  };

  return {
    wireSlotPointerDown,
    unwireChestKey,
    refreshSplitSource,
    detach: () => {
      document.removeEventListener("pointerdown", onDocumentPointerDownLeft);
      document.removeEventListener("pointermove", onDocumentPointerMove);
      document.removeEventListener("pointerup", onDocumentPointerUp);
      document.removeEventListener("keydown", onDocumentKeydown, true);
      cancelDrag();
      clearSplitSource();
      playerCells.clear();
      chestCellsByKey.clear();
    },
  };
}
