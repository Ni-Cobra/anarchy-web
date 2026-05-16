/**
 * Inventory-specific cell helpers. The shared inventory/chest cell
 * primitives (`makeSlotCell`, `paintSlot`, `applyItemIconStyle`) live in
 * `../slot_cell.ts` and are re-exported here so the existing inventory
 * import surface stays intact. The equipment-slot painter is
 * inventory-only and stays local.
 */

import { ItemId, type ItemStack, type ToolKind } from "../../game/index.js";
import { applyItemIconStyle } from "../slot_cell.js";

export {
  type CellEquipmentMark,
  applyItemIconStyle,
  makeSlotCell,
  paintSlot,
} from "../slot_cell.js";

/**
 * Paint one equipment-slot cell (task 100). Empty slots get a faded
 * silhouette of the wood-tier tool so the slot affordance reads as a
 * pickaxe / axe slot at a glance; populated slots paint the equipped
 * tool's full icon.
 */
export function paintEquipmentSlot(
  cell: HTMLDivElement,
  kind: ToolKind,
  item: ItemId | null,
): void {
  cell.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "anarchy-inventory-icon";
  if (item !== null) {
    applyItemIconStyle(icon, { item, count: 1 });
    cell.classList.remove("empty");
  } else {
    // Wood-tier silhouette is the cheapest "this is what goes here"
    // affordance for pickaxe / axe — same texture pipeline as the rest
    // of the inventory surface, just at low opacity. The CSS rule
    // `.empty .icon` knocks it down to ~30% alpha.
    //
    // Utility (task 360) has no items yet — the lantern lands in task
    // 370 — so the empty cell ships icon-less. The blue border on
    // `.anarchy-equipment-slot.utility` is enough affordance until a
    // real silhouette exists.
    const placeholder = utilityPlaceholder(kind);
    if (placeholder !== null) {
      applyItemIconStyle(icon, placeholder);
    }
    cell.classList.add("empty");
  }
  cell.appendChild(icon);
}

function utilityPlaceholder(kind: ToolKind): ItemStack | null {
  switch (kind) {
    case "pickaxe":
      return { item: ItemId.WoodPickaxe, count: 1 };
    case "axe":
      return { item: ItemId.WoodAxe, count: 1 };
    case "shovel":
      return { item: ItemId.WoodShovel, count: 1 };
    case "sword":
      return { item: ItemId.WoodSword, count: 1 };
    case "utility":
      return null;
  }
}
