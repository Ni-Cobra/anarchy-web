/**
 * Inventory overlay: a fixed bottom-center hotbar (always visible) and a
 * left-side sliding panel that exposes the main grid (slots
 * `HOTBAR_SLOTS..INVENTORY_SIZE`).
 *
 * Panel layout is **4 columns × 9 rows** (still 36 cells / `MAIN_SLOTS`),
 * row-major: panel slot `n` lives at `(row n/4, col n%4)` so slot 0 is the
 * top-left cell, slot 3 the top-right, slot 4 the start of the next row,
 * etc. Row-major matches CSS grid's natural flow and keeps the visually-
 * first cell aligned with wire-slot index `HOTBAR_SLOTS + 0`.
 *
 * Network-free: the module reads inventory state through a `getInventory`
 * thunk passed in by `bootstrap.ts` and subscribes to the live `Inventory`
 * mirror so each `InventoryUpdate` from the server triggers a re-render.
 *
 * ## Submodules
 *
 * The orchestration here stays under one closure so the hotbar / panel /
 * equipment cells, the selected-slot mirror, and the drag-and-drop state
 * machine can share state cheaply. The split is along role lines:
 * - [`./style`] — CSS injection + the layout constants the panel width
 *   derives from.
 * - [`./cells`] — pure DOM helpers (`makeSlotCell`, `paintSlot`,
 *   `paintEquipmentSlot`, `applyItemIconStyle`).
 * - [`./dragdrop`] — pointer state machine (pending click vs. promoted
 *   drag) plus the routing matrix that turns a release into the right
 *   wire action (`MoveSlot` / `EquipTool` / `UnequipTool`). Task 535
 *   added the cross-grid surface: the chest UI registers its cells
 *   through `wireChestSlot` and the dragdrop ships the right
 *   `srcChest` / `dstChest` flags on the wire.
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
 *
 * Pointer-down on any slot starts a *pending* gesture; the drag preview
 * only materializes once the cursor moves past the threshold. A
 * pointer-up before that threshold is a click — and on panel cells
 * (slots `>= HOTBAR_SLOTS`) the click ships a `MoveSlot(panel,
 * selectedHotbar)` so the server can merge / swap into the active hand.
 * On hotbar cells the click flips selection. The server's `try_move_slot`
 * handles the merge-with-overflow / swap-on-mismatch / move-into-empty
 * branches the click can produce.
 */

import {
  HOTBAR_SLOTS,
  type Inventory,
  MAIN_SLOTS,
  type ToolKind,
} from "../../game/index.js";
import { itemDisplayName } from "../../item_names.js";
import type { ChestKey } from "../chest/chest_key.js";
import { attachTooltip, type TooltipHandle } from "../tooltip.js";
import { makeSlotCell, paintEquipmentSlot, paintSlot } from "./cells.js";
import {
  attachDragDrop,
  type DragDropHandle,
  EQUIP_AXE_SLOT_ID,
  EQUIP_PICKAXE_SLOT_ID,
  EQUIP_SHOVEL_SLOT_ID,
  EQUIP_UTILITY_SLOT_ID,
  type SlotRef,
} from "./dragdrop.js";
import { injectStyle } from "./style.js";

export interface InventoryUiOptions {
  /** Reads the current inventory mirror. Called on every render. */
  readonly getInventory: () => Inventory;
  /**
   * Reads the inventory mirror for the chest identified by `chestKey`,
   * or `null` if no chest with that key is currently open. Optional
   * because the existing test suite predates the chest surface;
   * production wires this through `bootstrap.ts`. Task 591 promoted the
   * thunk to take a `chestKey` so the dragdrop machinery is ready for
   * N panels — for now bootstrap matches the single open chest against
   * the requested key.
   */
  readonly getChestInventory?: (chestKey: ChestKey) => Inventory | null;
  /**
   * Ship a `SelectSlot` action up to the server. Called by the keymap +
   * wheel hooks any time the local selection changes; the local mirror
   * updates immediately so the highlight is responsive, and the next
   * server `InventoryUpdate` is the authoritative correction (today the
   * server doesn't echo selection back, but the action is still
   * authoritatively applied per place validation).
   */
  readonly sendSelect: (slot: number) => void;
  /**
   * Ship a `MoveSlot` drag-drop action up to the server. The optional
   * cross-grid `chestKey` arguments name the chest a slot index lives
   * in (task 591); pass `null` (or omit) when the slot lives in the
   * player's own grid. Bootstrap turns the `chestKey` back into the
   * wire `ChestLocation` via `chestLocationFromKey`.
   */
  readonly sendMove: (
    src: number,
    dst: number,
    srcChestKey?: ChestKey | null,
    dstChestKey?: ChestKey | null,
  ) => void;
  /**
   * Ship a `TransferItems(src, dst, count)` action — the right-click
   * split flow. Optional because the existing test suite predates the
   * right-click split surface; production callers always pass it.
   */
  readonly sendTransfer?: (
    src: number,
    dst: number,
    count: number,
    srcChestKey?: ChestKey | null,
    dstChestKey?: ChestKey | null,
  ) => void;
  /** Ship an `EquipTool` action up to the server (task 100). */
  readonly sendEquip: (sourceSlot: number, kind: ToolKind) => void;
  /** Ship an `UnequipTool` action up to the server (task 100). */
  readonly sendUnequip: (kind: ToolKind) => void;
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
  /**
   * Register a chest-grid cell with the shared drag-and-drop machinery
   * (task 535/591). The chest panel manager calls this for every chest
   * slot when a panel mounts, passing the panel's `chestKey` so the
   * machinery is ready to address N panels (task 592 promotes this
   * from singleton to N).
   */
  wireChestSlot(chestKey: ChestKey, idx: number, cell: HTMLDivElement): void;
  /**
   * Drop the chest's cell registrations when its panel unmounts. The
   * panel manager calls this for every closed chest so the dragdrop
   * registry doesn't hold dangling DOM references and so a future
   * remount with the same `chestKey` starts from a clean slate.
   */
  unwireChestKey(chestKey: ChestKey): void;
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

  // Wrap the hotbar + equipment bar in a single horizontally-laid row so
  // the EQUIP_GAP_PX gap between the two clusters falls out of CSS flex
  // rather than absolute positioning of each cluster.
  const hotbarRow = document.createElement("div");
  hotbarRow.className = "anarchy-hotbar-row";

  const hotbar = document.createElement("div");
  hotbar.className = "anarchy-hotbar";
  hotbar.setAttribute("role", "toolbar");
  hotbar.setAttribute("aria-label", "Hotbar");
  hotbarRow.appendChild(hotbar);

  const equipmentBar = document.createElement("div");
  equipmentBar.className = "anarchy-equipment-bar";
  equipmentBar.setAttribute("role", "toolbar");
  equipmentBar.setAttribute("aria-label", "Equipment");
  hotbarRow.appendChild(equipmentBar);

  root.appendChild(hotbarRow);

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

  const equipmentCells: { kind: ToolKind; cell: HTMLDivElement }[] = [
    { kind: "pickaxe", cell: makeSlotCell() },
    { kind: "axe", cell: makeSlotCell() },
    { kind: "shovel", cell: makeSlotCell() },
    { kind: "utility", cell: makeSlotCell() },
  ];
  for (const { kind, cell } of equipmentCells) {
    cell.classList.add("anarchy-equipment-slot");
    cell.classList.add(`anarchy-equipment-slot-${kind}`);
    equipmentBar.appendChild(cell);
  }

  const panelCells: HTMLDivElement[] = [];
  for (let i = 0; i < MAIN_SLOTS; i++) {
    const cell = makeSlotCell();
    panel.appendChild(cell);
    panelCells.push(cell);
  }

  // Wire one tooltip handle per slot. The thunk reads the live `Inventory`
  // mirror each time so a count change between hovers (or a slot move that
  // swaps the underlying item) surfaces immediately on the next pointer
  // enter — no manual refresh needed.
  const tooltipHandles: TooltipHandle[] = [];
  const wireSlotTooltip = (idx: number, cell: HTMLDivElement): void => {
    tooltipHandles.push(
      attachTooltip(cell, () => {
        const slot = options.getInventory().slot(idx);
        if (slot === null) return null;
        const name = itemDisplayName(slot.item);
        return slot.count > 1 ? `${name} (${slot.count})` : name;
      }),
    );
  };
  for (let i = 0; i < HOTBAR_SLOTS; i++) wireSlotTooltip(i, hotbarCells[i]);
  for (let i = 0; i < MAIN_SLOTS; i++) {
    wireSlotTooltip(HOTBAR_SLOTS + i, panelCells[i]);
  }
  for (const { kind, cell } of equipmentCells) {
    tooltipHandles.push(
      attachTooltip(cell, () => {
        const equipped = options.getInventory().getEquipped(kind);
        if (equipped !== null) return itemDisplayName(equipped);
        switch (kind) {
          case "pickaxe":
            return "Pickaxe slot (empty)";
          case "axe":
            return "Axe slot (empty)";
          case "shovel":
            return "Shovel slot (empty)";
          case "utility":
            return "Utility slot (empty)";
        }
      }),
    );
  }

  let open = false;
  let selectedSlot = 0;

  // Wire-frame adapters. Equipment sentinels short-circuit before
  // hitting the wire (they're translated into EquipTool / UnequipTool
  // by the dragdrop's drop resolver). Regular cells unpack the slot
  // ref into the cross-grid `chestKey` arguments the wire expects.
  const refToChestKey = (ref: SlotRef): ChestKey | null =>
    ref.kind === "chest" ? ref.chestKey : null;
  const sendMove = (src: SlotRef, dst: SlotRef): void => {
    options.sendMove(src.idx, dst.idx, refToChestKey(src), refToChestKey(dst));
  };
  const sendTransfer = (src: SlotRef, dst: SlotRef, count: number): void => {
    options.sendTransfer?.(
      src.idx,
      dst.idx,
      count,
      refToChestKey(src),
      refToChestKey(dst),
    );
  };

  const dragdrop: DragDropHandle = attachDragDrop({
    getInventory: options.getInventory,
    getChestInventory:
      options.getChestInventory ?? ((_key) => null),
    getSelectedHotbarSlot: () => selectedSlot,
    sendMove,
    sendTransfer,
    sendEquip: options.sendEquip,
    sendUnequip: options.sendUnequip,
  });

  const render = (): void => {
    const inv = options.getInventory();
    const pickaxeSlot = inv.getEquippedSlot("pickaxe");
    const axeSlot = inv.getEquippedSlot("axe");
    const shovelSlot = inv.getEquippedSlot("shovel");
    const utilitySlot = inv.getEquippedSlot("utility");
    const equipMarkAt = (idx: number): ToolKind | null => {
      if (idx === pickaxeSlot) return "pickaxe";
      if (idx === axeSlot) return "axe";
      if (idx === shovelSlot) return "shovel";
      if (idx === utilitySlot) return "utility";
      return null;
    };
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      paintSlot(hotbarCells[i], inv.slot(i), i === selectedSlot, equipMarkAt(i));
    }
    for (let i = 0; i < MAIN_SLOTS; i++) {
      const flatIdx = HOTBAR_SLOTS + i;
      paintSlot(panelCells[i], inv.slot(flatIdx), false, equipMarkAt(flatIdx));
    }
    for (const { kind, cell } of equipmentCells) {
      paintEquipmentSlot(cell, kind, inv.getEquipped(kind));
    }
    // After re-painting, ask the dragdrop machinery to reconcile its
    // right-click split source — if a hold-transfer just drained the
    // source cell, the yellow border should clear.
    dragdrop.refreshSplitSource();
  };

  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    dragdrop.wireSlotPointerDown({ kind: "player", idx: i }, hotbarCells[i]);
  }
  for (let i = 0; i < MAIN_SLOTS; i++) {
    dragdrop.wireSlotPointerDown(
      { kind: "player", idx: HOTBAR_SLOTS + i },
      panelCells[i],
    );
  }
  dragdrop.wireSlotPointerDown(
    { kind: "player", idx: EQUIP_PICKAXE_SLOT_ID },
    equipmentCells[0].cell,
  );
  dragdrop.wireSlotPointerDown(
    { kind: "player", idx: EQUIP_AXE_SLOT_ID },
    equipmentCells[1].cell,
  );
  dragdrop.wireSlotPointerDown(
    { kind: "player", idx: EQUIP_SHOVEL_SLOT_ID },
    equipmentCells[2].cell,
  );
  dragdrop.wireSlotPointerDown(
    { kind: "player", idx: EQUIP_UTILITY_SLOT_ID },
    equipmentCells[3].cell,
  );

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

  // Equipment-slot click → unequip iff occupied. Empty equipment slots
  // are no-ops on click (there's no panel-cell selection model to source
  // the equip from). Drag-from-panel covers the equip path.
  for (const { kind, cell } of equipmentCells) {
    cell.addEventListener("click", () => {
      const equipped = options.getInventory().getEquipped(kind);
      if (equipped === null) return;
      options.sendUnequip(kind);
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

  const wireChestSlot = (
    chestKey: ChestKey,
    idx: number,
    cell: HTMLDivElement,
  ): void => {
    dragdrop.wireSlotPointerDown({ kind: "chest", chestKey, idx }, cell);
  };
  const unwireChestKey = (chestKey: ChestKey): void => {
    dragdrop.unwireChestKey(chestKey);
  };

  const unsubscribe = options.getInventory().subscribe(render);

  // Stop pointer events from reaching `window` so the bootstrap-level
  // mousedown / contextmenu handlers don't fire destroy / place when a
  // click lands on the hotbar or the panel. `contextmenu` also gets
  // `preventDefault` so the browser's native context menu doesn't
  // surface over the overlay — the world canvas gets the same
  // suppression in `bootstrap/break_place.ts`.
  for (const ev of ["mousedown", "mouseup", "click"] as const) {
    hotbar.addEventListener(ev, (e) => e.stopPropagation());
    equipmentBar.addEventListener(ev, (e) => e.stopPropagation());
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }
  const onContextMenu = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };
  hotbar.addEventListener("contextmenu", onContextMenu);
  equipmentBar.addEventListener("contextmenu", onContextMenu);
  panel.addEventListener("contextmenu", onContextMenu);

  document.body.appendChild(root);
  render();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    selectedHotbarSlot: () => selectedSlot,
    selectHotbarSlot,
    wireChestSlot,
    unwireChestKey,
    render,
    unmount: () => {
      unsubscribe();
      for (const handle of tooltipHandles) handle.detach();
      tooltipHandles.length = 0;
      dragdrop.detach();
      root.remove();
    },
  };
}
