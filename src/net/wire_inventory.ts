/**
 * `InventoryUpdate` message handler.
 *
 * The server ships the local player's inventory whenever its slots,
 * equipped tools, or craftable-recipe set changes. This module owns the
 * wire → `Inventory` translation: it shape-checks the slot count
 * defensively (a misbehaving server could drop the frame), decodes the
 * `Slot[]` and equipment pointers, and applies the result via
 * `Inventory.replaceFromWire`. Only the local player's inventory ever
 * crosses the wire — there is no "another player's inventory" path.
 */
import { anarchy } from "../gen/anarchy.js";
import { INVENTORY_SIZE, ItemId, type Slot } from "../game/index.js";

import type { WireDeps } from "./wire.js";

export function applyInventoryUpdate(
  update: anarchy.v1.IInventoryUpdate,
  deps: WireDeps,
): void {
  if (!deps.inventory) return;
  const wireSlots = update.slots ?? [];
  if (wireSlots.length !== INVENTORY_SIZE) {
    // Defensive: a misbehaving server could ship the wrong slot count.
    // Drop the frame rather than corrupt local state.
    return;
  }
  const slots: Slot[] = wireSlots.map((s): Slot => {
    const count = s.count ?? 0;
    if (count === 0) return null;
    const item = itemIdFromWire(s.item);
    if (item === null) return null;
    return { item, count };
  });
  // Equipment slot pointers (task 010 rework). `-1` (or any out-of-range
  // value) means "nothing equipped"; otherwise the index of the cell in
  // `slots` that holds the equipped tool. The Inventory mirror clamps
  // stale or non-tool indices to `null` defensively.
  const equippedPickaxeSlot = equippedSlotFromWire(update.equippedPickaxeSlot);
  const equippedAxeSlot = equippedSlotFromWire(update.equippedAxeSlot);
  const equippedUtilitySlot = equippedSlotFromWire(update.equippedUtilitySlot);
  const craftableRecipeIds = update.craftableRecipeIds ?? [];
  deps.inventory.replaceFromWire(
    slots,
    equippedPickaxeSlot,
    equippedAxeSlot,
    craftableRecipeIds,
    equippedUtilitySlot,
  );
}

function equippedSlotFromWire(slot: number | null | undefined): number | null {
  if (slot === null || slot === undefined) return null;
  if (slot < 0) return null;
  if (slot >= INVENTORY_SIZE) return null;
  return slot;
}

function itemIdFromWire(
  item: anarchy.v1.ItemId | null | undefined,
): ItemId | null {
  switch (item) {
    case anarchy.v1.ItemId.ITEM_ID_STICK:
      return ItemId.Stick;
    case anarchy.v1.ItemId.ITEM_ID_WOOD:
      return ItemId.Wood;
    case anarchy.v1.ItemId.ITEM_ID_STONE:
      return ItemId.Stone;
    case anarchy.v1.ItemId.ITEM_ID_GOLD:
      return ItemId.Gold;
    case anarchy.v1.ItemId.ITEM_ID_WOOD_PICKAXE:
      return ItemId.WoodPickaxe;
    case anarchy.v1.ItemId.ITEM_ID_STONE_PICKAXE:
      return ItemId.StonePickaxe;
    case anarchy.v1.ItemId.ITEM_ID_COPPER_PICKAXE:
      return ItemId.CopperPickaxe;
    case anarchy.v1.ItemId.ITEM_ID_IRON_PICKAXE:
      return ItemId.IronPickaxe;
    case anarchy.v1.ItemId.ITEM_ID_TUNGSTEN_PICKAXE:
      return ItemId.TungstenPickaxe;
    case anarchy.v1.ItemId.ITEM_ID_WOOD_AXE:
      return ItemId.WoodAxe;
    case anarchy.v1.ItemId.ITEM_ID_STONE_AXE:
      return ItemId.StoneAxe;
    case anarchy.v1.ItemId.ITEM_ID_COPPER_AXE:
      return ItemId.CopperAxe;
    case anarchy.v1.ItemId.ITEM_ID_IRON_AXE:
      return ItemId.IronAxe;
    case anarchy.v1.ItemId.ITEM_ID_TUNGSTEN_AXE:
      return ItemId.TungstenAxe;
    case anarchy.v1.ItemId.ITEM_ID_FLOWER_RED:
      return ItemId.FlowerRed;
    case anarchy.v1.ItemId.ITEM_ID_FLOWER_YELLOW:
      return ItemId.FlowerYellow;
    case anarchy.v1.ItemId.ITEM_ID_FLOWER_BLUE:
      return ItemId.FlowerBlue;
    case anarchy.v1.ItemId.ITEM_ID_FLOWER_WHITE:
      return ItemId.FlowerWhite;
    case anarchy.v1.ItemId.ITEM_ID_BUSH:
      return ItemId.Bush;
    case anarchy.v1.ItemId.ITEM_ID_DIRT:
      return ItemId.Dirt;
    case anarchy.v1.ItemId.ITEM_ID_SAND:
      return ItemId.Sand;
    case anarchy.v1.ItemId.ITEM_ID_GRAVEL:
      return ItemId.Gravel;
    case anarchy.v1.ItemId.ITEM_ID_STONE_LIGHT:
      return ItemId.StoneLight;
    case anarchy.v1.ItemId.ITEM_ID_STONE_DARK:
      return ItemId.StoneDark;
    case anarchy.v1.ItemId.ITEM_ID_RAW_COPPER:
      return ItemId.RawCopper;
    case anarchy.v1.ItemId.ITEM_ID_RAW_IRON:
      return ItemId.RawIron;
    case anarchy.v1.ItemId.ITEM_ID_RAW_TUNGSTEN:
      return ItemId.RawTungsten;
    case anarchy.v1.ItemId.ITEM_ID_COAL:
      return ItemId.Coal;
    case anarchy.v1.ItemId.ITEM_ID_DIAMOND:
      return ItemId.Diamond;
    case anarchy.v1.ItemId.ITEM_ID_COPPER_INGOT:
      return ItemId.CopperIngot;
    case anarchy.v1.ItemId.ITEM_ID_IRON_INGOT:
      return ItemId.IronIngot;
    case anarchy.v1.ItemId.ITEM_ID_TUNGSTEN_INGOT:
      return ItemId.TungstenIngot;
    case anarchy.v1.ItemId.ITEM_ID_TORCH:
      return ItemId.Torch;
    default:
      return null;
  }
}
