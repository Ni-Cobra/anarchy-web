/**
 * Per-player inventory mirror — a flat array of `Slot`s split into a 9-slot
 * hotbar and a 36-slot main grid. Network-free: this module knows nothing
 * about WebSockets or protobuf; the wire bridge in `../net/wire.ts` decodes
 * incoming `InventoryUpdate` frames and writes the resulting state here.
 *
 * Mirrors `anarchy-server/src/game/inventory.rs`. Indexing is flat
 * `0..INVENTORY_SIZE`. Indices `0..HOTBAR_SLOTS` are the hotbar;
 * `HOTBAR_SLOTS..INVENTORY_SIZE` are the main grid. The split is observational
 * today — task 030 will add UI rendering and task 040 will add interactions
 * (slot moves, place-consume, break-drops).
 *
 * Invariants the inventory upholds (matched by the server):
 * - A `Some(stack)` slot always has `count >= 1` — empty slots are `null`.
 * - Slot count is fixed: `INVENTORY_SIZE = 45`. The wire bridge rejects
 *   frames whose `slots` array does not match this length.
 */

/** Hotbar slot count — the bottom row addressable by a number key in the UI. */
export const HOTBAR_SLOTS = 9;
/** Main-grid slot count — the upper region of the inventory window. */
export const MAIN_SLOTS = 36;
/**
 * Total addressable slots. Hotbar lives in `0..HOTBAR_SLOTS`; main lives in
 * `HOTBAR_SLOTS..INVENTORY_SIZE`.
 */
export const INVENTORY_SIZE = HOTBAR_SLOTS + MAIN_SLOTS;

/**
 * One kind of carryable item. Mirrors `crate::game::ItemId` and the proto
 * `ItemId` enum. Numeric values are arbitrary but stable; extend by appending.
 */
export enum ItemId {
  Stick = 1,
  Wood = 2,
  Stone = 3,
  Gold = 4,
}

/** A non-empty pile of one item kind. */
export interface ItemStack {
  readonly item: ItemId;
  readonly count: number;
}

/**
 * One inventory cell. `null` is the canonical empty; a non-null `Slot`
 * always carries `count >= 1`. The shape mirrors the server's
 * `Slot = Option<ItemStack>`.
 */
export type Slot = ItemStack | null;

/**
 * Per-player inventory. Slots are addressed flat — the hotbar/main split is
 * a constant-driven offset, not a separate field.
 */
export class Inventory {
  private slots: Slot[];

  constructor() {
    this.slots = Array.from({ length: INVENTORY_SIZE }, () => null);
  }

  /** Read a single slot by flat index. Returns `null` for out-of-range indices. */
  slot(idx: number): Slot {
    if (idx < 0 || idx >= INVENTORY_SIZE) return null;
    return this.slots[idx];
  }

  /** Read every slot in order, hotbar first then main. */
  allSlots(): readonly Slot[] {
    return this.slots;
  }

  /**
   * Total items of a given kind across all slots. Useful for tests and
   * future "have enough to craft?" predicates.
   */
  countOf(item: ItemId): number {
    let total = 0;
    for (const s of this.slots) {
      if (s && s.item === item) total += s.count;
    }
    return total;
  }

  /**
   * Replace the inventory wholesale from a decoded `InventoryUpdate` frame.
   * Throws if `slots.length` does not match `INVENTORY_SIZE` — the wire
   * bridge guards against malformed frames before reaching here.
   */
  replaceFromWire(slots: readonly Slot[]): void {
    if (slots.length !== INVENTORY_SIZE) {
      throw new Error(
        `inventory slot array length ${slots.length} != ${INVENTORY_SIZE}`,
      );
    }
    this.slots = slots.slice();
  }
}
