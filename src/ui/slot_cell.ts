/**
 * Shared DOM helpers for one slot cell. Used by both the inventory grid
 * (`ui/inventory/cells.ts`) and the chest panel grid
 * (`ui/chest/panel_manager.ts`) so a slot-render bug only ever needs
 * fixing once. The helpers are render-only — no state, no listeners.
 *
 * The outer cell carries a grid-specific class (`anarchy-inventory-slot`
 * for the inventory grid, `anarchy-chest-slot` for the chest grid) so
 * the dragdrop registry can tell the two grids apart. The *interior*
 * (icon background, count badge, pixelated rendering) is identical
 * across both grids and lives here.
 *
 * Items render as 64×64 pixel-art textures sourced from
 * `src/textures.ts` — the same file that feeds the world renderer, so a
 * slot icon and the placed block share a pixel-perfect visual identity.
 * `image-rendering: pixelated` keeps the upscale crisp, mirroring the
 * `THREE.NearestFilter` intent on the renderer side.
 */

import { type ItemStack, type Slot, type ToolKind } from "../game/index.js";
import { textureUrlForItem } from "../textures.js";

/**
 * Equipment kind currently flagged on a cell, or `null` for cells that
 * are not equipped to any kind. Drives the colored-background paint on
 * the inventory cell — orange for pickaxe, green for axe, blue for
 * utility.
 */
export type CellEquipmentMark = ToolKind | null;

/**
 * Apply the per-item texture to a slot icon element. Items that map to a
 * `BlockType` (today: every `ItemId` — they all place blocks) reuse the
 * world-renderer texture so the inventory and the placed block share a
 * pixel-perfect visual identity. Items without a texture (future tools /
 * consumables) get a neutral gray fallback.
 */
export function applyItemIconStyle(icon: HTMLElement, slot: ItemStack): void {
  const url = textureUrlForItem(slot.item);
  if (url) {
    icon.style.backgroundImage = `url("${url}")`;
    icon.style.backgroundSize = "100% 100%";
    icon.style.backgroundRepeat = "no-repeat";
    icon.style.imageRendering = "pixelated";
  } else {
    icon.style.background = "#888";
  }
}

/**
 * Create an empty slot-cell `<div>`. `className` selects the grid the
 * cell belongs to — the inventory default keeps the existing inventory
 * call-sites unchanged; the chest panel passes `"anarchy-chest-slot"`.
 */
export function makeSlotCell(
  className: string = "anarchy-inventory-slot",
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export function paintSlot(
  cell: HTMLDivElement,
  slot: Slot,
  selected: boolean,
  equipped: CellEquipmentMark = null,
): void {
  cell.classList.toggle("selected", selected);
  cell.classList.toggle("equipped-pickaxe", equipped === "pickaxe");
  cell.classList.toggle("equipped-axe", equipped === "axe");
  cell.classList.toggle("equipped-utility", equipped === "utility");
  cell.classList.toggle("equipped-shovel", equipped === "shovel");
  cell.classList.toggle("equipped-sword", equipped === "sword");
  cell.replaceChildren();
  if (slot === null) return;
  const icon = document.createElement("div");
  icon.className = "anarchy-inventory-icon";
  applyItemIconStyle(icon, slot);
  cell.appendChild(icon);
  if (slot.count > 1) {
    const count = document.createElement("span");
    count.className = "anarchy-inventory-count";
    count.textContent = String(slot.count);
    cell.appendChild(count);
  }
}
