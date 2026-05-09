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
 *
 * Variants 5..14 are the task-090 tool family — pickaxe and axe in five
 * material tiers (Wood, Stone, Copper, Iron, Tungsten). Tools are inert in
 * this iteration: holding one in the hotbar does not enable
 * mining-with-tools yet (task 120). They have no `places_block`, so a
 * right-click while a tool is selected is a server-side no-op.
 */
export enum ItemId {
  Stick = 1,
  Wood = 2,
  Stone = 3,
  Gold = 4,
  WoodPickaxe = 5,
  StonePickaxe = 6,
  CopperPickaxe = 7,
  IronPickaxe = 8,
  TungstenPickaxe = 9,
  WoodAxe = 10,
  StoneAxe = 11,
  CopperAxe = 12,
  IronAxe = 13,
  TungstenAxe = 14,
  /**
   * Task 130 decorative drops. Each flower variant has its own item form so
   * a player can replant the variant they picked up. `Bush` exists for
   * symmetry with the place-from-inventory affordance, but bushes drop
   * sticks rather than themselves so a Bush item is not normally obtainable
   * through gameplay.
   */
  FlowerRed = 15,
  FlowerYellow = 16,
  FlowerBlue = 17,
  FlowerWhite = 18,
  Bush = 19,
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
 * Identifies one of the two equipment-slot mini-hotbar cells (task 100).
 * Mirrors the proto `ToolKind` enum and the server's `game::ToolKind`.
 */
export type ToolKind = "pickaxe" | "axe";

/**
 * `true` iff `item` is one of the five pickaxe tiers. Used by the
 * inventory UI's click-routing to decide whether a panel-cell click
 * should target the equipment slot or the active hotbar.
 */
export function isPickaxe(item: ItemId): boolean {
  return (
    item === ItemId.WoodPickaxe ||
    item === ItemId.StonePickaxe ||
    item === ItemId.CopperPickaxe ||
    item === ItemId.IronPickaxe ||
    item === ItemId.TungstenPickaxe
  );
}

/** True iff `item` is one of the five axe tiers. */
export function isAxe(item: ItemId): boolean {
  return (
    item === ItemId.WoodAxe ||
    item === ItemId.StoneAxe ||
    item === ItemId.CopperAxe ||
    item === ItemId.IronAxe ||
    item === ItemId.TungstenAxe
  );
}

/** Tool family the item belongs to, or `null` for non-tool items. */
export function toolKindOf(item: ItemId): ToolKind | null {
  if (isPickaxe(item)) return "pickaxe";
  if (isAxe(item)) return "axe";
  return null;
}

/**
 * Per-player inventory. Slots are addressed flat — the hotbar/main split is
 * a constant-driven offset, not a separate field.
 *
 * Equipment is a flag pointing at an inventory cell (task 010 rework):
 * the equipped pickaxe / axe is identified by a slot index, and the tool
 * itself stays in its inventory cell. The HUD reads
 * [`getEquippedSlot`] to paint the colored highlight on the equipped
 * cell and to mirror the cell into the mini-hotbar equipment panel.
 */
export class Inventory {
  private slots: Slot[];
  private equippedPickaxeSlot: number | null = null;
  private equippedAxeSlot: number | null = null;
  private craftable: readonly string[] = [];
  private listeners: Array<() => void> = [];

  constructor() {
    this.slots = Array.from({ length: INVENTORY_SIZE }, () => null);
  }

  /**
   * Stable recipe ids (e.g. `"wood-pickaxe"`) that the server most recently
   * advertised as currently craftable from this inventory's pooled counts.
   * The client recipe table in [`../recipes.ts`] looks these up to render
   * the crafting panel's ingredient / output preview. The server still
   * re-validates at `CraftRequest` time, so this is purely an affordance
   * filter.
   */
  getCraftableRecipeIds(): readonly string[] {
    return this.craftable;
  }

  /**
   * Inventory slot index flagged as the equipped tool of `kind`, or `null`
   * if nothing is equipped. The cell at this index holds the tool — see
   * [`getEquipped`] for the resolved item.
   */
  getEquippedSlot(kind: ToolKind): number | null {
    return kind === "pickaxe" ? this.equippedPickaxeSlot : this.equippedAxeSlot;
  }

  /**
   * Tool currently equipped to the equipment slot named by `kind`,
   * derived from the inventory cell at [`getEquippedSlot`]. `null` when
   * no slot is flagged or the flagged cell doesn't hold a matching tool
   * (defensive — the wire surface clamps these in practice).
   */
  getEquipped(kind: ToolKind): ItemId | null {
    const idx = this.getEquippedSlot(kind);
    if (idx === null) return null;
    const slot = this.slot(idx);
    if (slot === null) return null;
    if (toolKindOf(slot.item) !== kind) return null;
    return slot.item;
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
   * True iff `idx` is currently the equipped slot for `kind`. Used by the
   * inventory UI's render loop to paint the orange (pickaxe) / green (axe)
   * highlight on the equipped cell.
   */
  isEquippedAt(kind: ToolKind, idx: number): boolean {
    return this.getEquippedSlot(kind) === idx;
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
   * bridge guards against malformed frames before reaching here. Notifies
   * subscribers after the swap so a UI mirror can re-render reactively.
   *
   * `equippedPickaxeSlot` / `equippedAxeSlot` carry the equipped-cell
   * pointers (task 010 rework). Either may be `null` to mean "nothing
   * equipped"; out-of-range or non-tool-bearing indices are normalized
   * to `null` defensively so the UI never paints a wrong-color highlight.
   *
   * `craftableRecipeIds` carries the server's per-tick advertise of recipes
   * whose ingredients are currently covered (task 090). The list is stored
   * verbatim — the recipe-id space is the server's responsibility — and
   * sorted before storage so the crafting panel's render order is stable
   * across ticks.
   */
  replaceFromWire(
    slots: readonly Slot[],
    equippedPickaxeSlot: number | null = null,
    equippedAxeSlot: number | null = null,
    craftableRecipeIds: readonly string[] = [],
  ): void {
    if (slots.length !== INVENTORY_SIZE) {
      throw new Error(
        `inventory slot array length ${slots.length} != ${INVENTORY_SIZE}`,
      );
    }
    this.slots = slots.slice();
    this.equippedPickaxeSlot = normalizeEquipped(this.slots, equippedPickaxeSlot, "pickaxe");
    this.equippedAxeSlot = normalizeEquipped(this.slots, equippedAxeSlot, "axe");
    this.craftable = [...craftableRecipeIds].sort();
    for (const listener of this.listeners) listener();
  }

  /**
   * Register a change listener. Returns an unsubscribe function. The
   * inventory UI uses this to re-render when an `InventoryUpdate` arrives;
   * future mutators (slot moves, place-consume) will hit the same channel.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

function normalizeEquipped(
  slots: readonly Slot[],
  slot: number | null,
  kind: ToolKind,
): number | null {
  if (slot === null) return null;
  if (slot < 0 || slot >= slots.length) return null;
  const cell = slots[slot];
  if (cell === null) return null;
  if (toolKindOf(cell.item) !== kind) return null;
  return slot;
}
