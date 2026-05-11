/**
 * Pointer state machine for inventory cells: pending click vs. promoted
 * drag, plus the drop dispatcher that routes a release to the right wire
 * action (`MoveSlot` / `EquipTool` / `UnequipTool`), AND the right-click
 * split state machine (BACKLOG 410) that arms a "source" cell on
 * right-click and ramps a per-tick `TransferItems(src, dst, 1)` while
 * right-mouse is held over a destination.
 *
 * Every cell that should participate (hotbar + panel + equipment) has its
 * pointerdown wired via [`attachDragDrop`]'s returned `wireSlotPointerDown`.
 * Document-level pointermove / pointerup / keydown(Escape) listeners drive
 * promotion + drop + abort and unwind via the returned `detach`.
 *
 * Routing matrix for a completed drop (src → dst):
 * - regular → regular     : `sendMove` (`MoveSlot`)
 * - regular → equipment   : `sendEquip` if kind matches; otherwise rejected
 * - equipment → regular   : `sendUnequip` (server picks first free slot)
 * - equipment → equipment : silently dropped
 *
 * Right-click split (regular cells only — equipment slots ignore right-click):
 * - First right-click on a non-empty cell **arms** that cell as the split
 *   source (sticky `.split-source` border).
 * - With a source armed, right-clicking a different regular cell **starts
 *   a hold transfer** toward that cell — first frame fires immediately,
 *   then the timer ramps from a slow tick (~500 ms) to a fast tick
 *   (~100 ms) over `RAMP_END_MS` so the user can dribble out a few items
 *   or pour the whole stack.
 * - Right-click release stops the timer; the source stays armed.
 * - Any left-click clears the source.
 */

import {
  HOTBAR_SLOTS,
  type Inventory,
  ItemId,
  toolKindOf,
  type ToolKind,
} from "../../game/index.js";
import { applyItemIconStyle } from "./cells.js";

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
 * pointer-down into a drag instead of a click. Below this, the gesture
 * is a click — on panel cells, that ships a `MoveSlot` to the selected
 * hotbar; on hotbar cells, the existing click handler flips selection.
 */
const DRAG_THRESHOLD_PX_SQ = 25;

/**
 * Right-click hold transfer pacing (BACKLOG 410). The first frame fires
 * immediately on press; subsequent frames pace from `SLOW_INTERVAL_MS`
 * down to `FAST_INTERVAL_MS` over `RAMP_END_MS`. Numbers tuned for
 * "dribble a few items by tapping, dump the stack by holding".
 */
const SPLIT_SLOW_INTERVAL_MS = 500;
const SPLIT_FAST_INTERVAL_MS = 100;
const SPLIT_RAMP_END_MS = 2000;

/** Linear ramp from `SLOW` → `FAST` interval over `RAMP_END_MS`. */
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
  cellByIndex: (idx: number) => HTMLDivElement | null;
  slotIndexFromCell: (cell: HTMLElement) => number | null;
  itemAtIndex: (idx: number) => ItemId | null;
  getInventory: () => Inventory;
  /** Read the currently-highlighted hotbar slot for click-into-hand. */
  getSelectedHotbarSlot: () => number;
  sendMove: (src: number, dst: number) => void;
  /**
   * Ship a `TransferItems(src, dst, count)` action — the right-click split
   * flow's wire surface. The state machine here only ever calls with
   * `count = 1` per ramp tick; the server is the source of truth and may
   * reject (e.g. dst capped, mismatched kind).
   */
  sendTransfer: (src: number, dst: number, count: number) => void;
  sendEquip: (sourceSlot: number, kind: ToolKind) => void;
  sendUnequip: (kind: ToolKind) => void;
}

export interface DragDropHandle {
  /**
   * Wire pointer-down on `cell` so it opens a pending gesture for the
   * slot index `idx`. Promotion to a drag happens at the document level.
   */
  wireSlotPointerDown: (idx: number, cell: HTMLDivElement) => void;
  /**
   * Reconcile the right-click split source state with the current
   * inventory: if the armed source cell is now empty (e.g. an in-flight
   * hold-transfer drained it), clear the source. Called by the
   * orchestrator after each `paintSlot` pass so the yellow border doesn't
   * linger on a now-empty cell.
   */
  refreshSplitSource: () => void;
  detach: () => void;
}

/**
 * Install the pointer state machine. Returns per-cell wiring + a `detach`
 * that removes every document-level listener registered here.
 */
export function attachDragDrop(ctx: DragDropContext): DragDropHandle {
  // Pending-gesture state: pointer-down landed on `pointerSrc` at
  // `pointerStart`. While the gesture stays inside `DRAG_THRESHOLD_PX_SQ`
  // it remains a click candidate; once the cursor exceeds the threshold
  // it promotes to a drag (`dragSrc` set + floating preview). Both null
  // outside an active gesture.
  let pointerSrc: number | null = null;
  let pointerStart: { x: number; y: number } | null = null;
  let dragSrc: number | null = null;
  let dragPreview: HTMLDivElement | null = null;

  const beginDrag = (src: number, ev: PointerEvent): void => {
    const item = ctx.itemAtIndex(src);
    if (item === null) return;
    dragSrc = src;
    ctx.cellByIndex(src)?.classList.add("drag-source");
    const preview = document.createElement("div");
    preview.className = "anarchy-inventory-drag-preview";
    const icon = document.createElement("div");
    icon.className = "anarchy-inventory-icon";
    applyItemIconStyle(icon, { item, count: 1 });
    preview.appendChild(icon);
    // Equipment slots hold count-1 tools so we never paint a count badge
    // for a drag preview originating there. For panel/hotbar drags the
    // existing count badge surfaces.
    if (equipKindForSentinel(src) === null) {
      const slot = ctx.getInventory().slot(src);
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
      ctx.cellByIndex(dragSrc)?.classList.remove("drag-source");
    }
    dragSrc = null;
    if (dragPreview !== null) {
      dragPreview.remove();
      dragPreview = null;
    }
  };

  // Drop resolver. See routing matrix in the module docstring.
  const handleDrop = (src: number, dst: number): void => {
    const srcKind = equipKindForSentinel(src);
    const dstKind = equipKindForSentinel(dst);

    if (srcKind !== null && dstKind !== null) {
      // Equipment ↔ equipment drag — no defined semantics; ignore.
      return;
    }
    if (srcKind === null && dstKind !== null) {
      // Panel → equipment: kind-guard then equip.
      const stack = ctx.getInventory().slot(src);
      if (stack === null) return;
      if (toolKindOf(stack.item) !== dstKind) return;
      ctx.sendEquip(src, dstKind);
      return;
    }
    if (srcKind !== null && dstKind === null) {
      // Equipment → panel: unequip. The server writes the tool into the
      // first empty slot, which is what the user expects when they drop
      // onto an empty cell (the most common case).
      ctx.sendUnequip(srcKind);
      return;
    }
    ctx.sendMove(src, dst);
  };

  // Right-click split state (BACKLOG 410). `splitSource` is the cell idx
  // armed for partial transfer (yellow border); sticky until cleared by a
  // left-click. `splitTimer` is the active hold-transfer interval — fires
  // `TransferItems(src, dst, 1)` at a ramping rate while right-mouse is
  // held down on the destination.
  let splitSource: number | null = null;
  let splitTimer: ReturnType<typeof setInterval> | null = null;
  let splitTimerStartedAt = 0;
  let splitTimerDest: number | null = null;

  const setSplitSourceClass = (
    prev: number | null,
    next: number | null,
  ): void => {
    if (prev !== null) ctx.cellByIndex(prev)?.classList.remove("split-source");
    if (next !== null) ctx.cellByIndex(next)?.classList.add("split-source");
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

  /**
   * Right-click on `idx`: arm the split source if none is set, otherwise
   * start a hold-transfer toward `idx`. Equipment slots ignore right-click
   * (their UX is left-click drag-and-drop only).
   */
  const beginSplitGesture = (idx: number): void => {
    if (equipKindForSentinel(idx) !== null) return;
    if (splitSource === null) {
      // Arm only if the cell holds something — splitting from an empty
      // cell would have no transfer to make.
      if (ctx.itemAtIndex(idx) === null) return;
      splitSource = idx;
      setSplitSourceClass(null, idx);
      return;
    }
    if (idx === splitSource) {
      // Right-click on the armed cell itself: clear the selection so the
      // user can re-arm a different cell without a left-click round-trip.
      clearSplitSource();
      return;
    }
    // Start a hold-transfer toward `idx`. First frame fires immediately
    // so the user gets feedback on press; the interval handles the
    // ramping rate from then on.
    const src = splitSource;
    stopSplitTimer();
    splitTimerDest = idx;
    splitTimerStartedAt = performance.now();
    ctx.sendTransfer(src, idx, 1);
    const tickFn = (): void => {
      // The dest can change between ticks if the user re-presses on a
      // different cell — we cancel + re-arm in the pointerdown path, so
      // the dest captured here is the live target.
      const dst = splitTimerDest;
      if (dst === null || splitSource === null) {
        stopSplitTimer();
        return;
      }
      ctx.sendTransfer(splitSource, dst, 1);
      // Reschedule with the ramped interval. We can't simply use
      // setInterval with a ramp, so the interval recomputes itself by
      // tearing itself down + setting a fresh setTimeout.
      const elapsed = performance.now() - splitTimerStartedAt;
      const next = splitIntervalForElapsed(elapsed);
      if (splitTimer !== null) clearInterval(splitTimer);
      splitTimer = setInterval(tickFn, next);
    };
    splitTimer = setInterval(tickFn, splitIntervalForElapsed(0));
  };

  const wireSlotPointerDown = (idx: number, cell: HTMLDivElement): void => {
    cell.addEventListener("pointerdown", (ev) => {
      if (ev.button === 2) {
        // Right-click: split source / hold-transfer. Suppress the browser
        // contextmenu fallback locally — `contextmenu` itself is also
        // suppressed at the inventory root, but `preventDefault` here is
        // belt-and-braces for browsers that fire it on pointerdown.
        ev.preventDefault();
        beginSplitGesture(idx);
        return;
      }
      if (ev.button !== 0) return;
      ev.preventDefault();
      // Any left-click clears a sticky split source — matches the spec
      // ("the source is sticky until the user clicks elsewhere"). The
      // pending-gesture / drag is independent of the split flow.
      clearSplitSource();
      pointerSrc = idx;
      pointerStart = { x: ev.clientX, y: ev.clientY };
    });
  };

  // Document-level left-click pointerdown clears a sticky split source
  // when the click landed outside any inventory cell (cells handle their
  // own clear in `wireSlotPointerDown`). Matches the spec — "the source
  // is sticky until the user clicks elsewhere".
  const onDocumentPointerDownLeft = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    if (splitSource === null) return;
    // If the click landed on a wired inventory cell, the per-cell listener
    // already cleared (or re-armed) — nothing to do here.
    const target = ev.target;
    if (target instanceof HTMLElement && target.closest(".anarchy-inventory-slot") !== null) {
      return;
    }
    clearSplitSource();
  };
  document.addEventListener("pointerdown", onDocumentPointerDownLeft);

  // Cursor follow + drag promotion + drop resolution at document level
  // so a drag that releases outside any slot cancels cleanly. The first
  // pointermove past the threshold promotes the pending gesture into a
  // drag; once promoted (or once the source was empty), `pointerSrc`
  // clears so the click path can't double-fire on pointerup.
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

  const onDocumentPointerUp = (ev: PointerEvent): void => {
    if (ev.button === 2) {
      // Right-mouse-up always stops an in-flight hold-transfer. The split
      // source stays armed — re-pressing on any cell resumes the transfer
      // at the slow rate.
      stopSplitTimer();
      return;
    }
    const clickSrc = pointerSrc;
    pointerSrc = null;
    pointerStart = null;

    if (dragSrc !== null) {
      const src = dragSrc;
      cancelDrag();
      const targets = document.elementsFromPoint(ev.clientX, ev.clientY);
      let dst: number | null = null;
      for (const t of targets) {
        if (t instanceof HTMLElement && t.classList.contains("anarchy-inventory-slot")) {
          dst = ctx.slotIndexFromCell(t);
          if (dst !== null) break;
        }
      }
      if (dst === null || dst === src) return;
      handleDrop(src, dst);
      return;
    }

    // No drag → was this a click on a slot? Hotbar cells own the click
    // via their per-cell `click` listener (selection); equipment slots
    // own theirs (unequip). We only fire the click-to-equip / merge path
    // for panel cells here.
    if (clickSrc === null) return;
    if (clickSrc < 0) return;
    if (clickSrc < HOTBAR_SLOTS) return;
    const inv = ctx.getInventory();
    const stack = inv.slot(clickSrc);
    const tool = stack !== null ? toolKindOf(stack.item) : null;
    if (tool !== null) {
      // Tool click: equip into the matching equipment slot. The server's
      // atomic swap returns whatever was there into the source slot.
      ctx.sendEquip(clickSrc, tool);
      return;
    }
    // Swap-with-air: an empty endpoint on either side is still a valid
    // swap (server's `try_move_slot` runs `merge_stacks || swap_slots`,
    // which moves the non-empty stack into the empty cell). Skip the
    // wire frame only when both ends are empty — the server would NOOP.
    const dst = ctx.getSelectedHotbarSlot();
    if (stack === null && inv.slot(dst) === null) return;
    ctx.sendMove(clickSrc, dst);
  };
  document.addEventListener("pointerup", onDocumentPointerUp);

  // Escape during a drag (or pending click gesture) aborts cleanly — no
  // `sendMove` fires and the preview / drag-source highlight clears.
  // Also clears any armed split source. Listener is captured so a game-
  // side keydown handler can't preempt it.
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
    if (ctx.itemAtIndex(splitSource) === null) {
      clearSplitSource();
      return;
    }
    // Re-apply the class — `paintSlot` doesn't touch it, but a defensive
    // reapply here means a future renderer that calls `replaceChildren`
    // wouldn't accidentally wipe the affordance.
    setSplitSourceClass(null, splitSource);
  };

  return {
    wireSlotPointerDown,
    refreshSplitSource,
    detach: () => {
      document.removeEventListener("pointerdown", onDocumentPointerDownLeft);
      document.removeEventListener("pointermove", onDocumentPointerMove);
      document.removeEventListener("pointerup", onDocumentPointerUp);
      document.removeEventListener("keydown", onDocumentKeydown, true);
      cancelDrag();
      clearSplitSource();
    },
  };
}
