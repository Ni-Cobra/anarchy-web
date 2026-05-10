/**
 * Pointer state machine for inventory cells: pending click vs. promoted
 * drag, plus the drop dispatcher that routes a release to the right wire
 * action (`MoveSlot` / `EquipTool` / `UnequipTool`).
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
 * the two equipment slots. Outside `[0, INVENTORY_SIZE)` so the wire
 * `MoveSlot` path can never confuse them with a real slot index — the
 * UI translates the sentinels into `EquipTool` / `UnequipTool` actions
 * before sending.
 */
export const EQUIP_PICKAXE_SLOT_ID = -1;
export const EQUIP_AXE_SLOT_ID = -2;

/**
 * Squared cursor-movement threshold (in CSS pixels) that flips a
 * pointer-down into a drag instead of a click. Below this, the gesture
 * is a click — on panel cells, that ships a `MoveSlot` to the selected
 * hotbar; on hotbar cells, the existing click handler flips selection.
 */
const DRAG_THRESHOLD_PX_SQ = 25;

export function equipKindForSentinel(idx: number): ToolKind | null {
  if (idx === EQUIP_PICKAXE_SLOT_ID) return "pickaxe";
  if (idx === EQUIP_AXE_SLOT_ID) return "axe";
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
  sendEquip: (sourceSlot: number, kind: ToolKind) => void;
  sendUnequip: (kind: ToolKind) => void;
}

export interface DragDropHandle {
  /**
   * Wire pointer-down on `cell` so it opens a pending gesture for the
   * slot index `idx`. Promotion to a drag happens at the document level.
   */
  wireSlotPointerDown: (idx: number, cell: HTMLDivElement) => void;
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

  const wireSlotPointerDown = (idx: number, cell: HTMLDivElement): void => {
    cell.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      pointerSrc = idx;
      pointerStart = { x: ev.clientX, y: ev.clientY };
    });
  };

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
  // Listener is captured so a game-side keydown handler can't preempt it.
  const onDocumentKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    if (dragSrc === null && pointerSrc === null) return;
    pointerSrc = null;
    pointerStart = null;
    cancelDrag();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  return {
    wireSlotPointerDown,
    detach: () => {
      document.removeEventListener("pointermove", onDocumentPointerMove);
      document.removeEventListener("pointerup", onDocumentPointerUp);
      document.removeEventListener("keydown", onDocumentKeydown, true);
      cancelDrag();
    },
  };
}
