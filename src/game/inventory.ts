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
  /**
   * Task 140 ground-block-variety drops. Each places its matching block.
   * `StoneLight` / `StoneDark` are sibling variants of `Stone` — same item
   * stacking shape, different placed block.
   */
  Dirt = 20,
  Sand = 21,
  Gravel = 22,
  StoneLight = 23,
  StoneDark = 24,
  /**
   * Task 150 raw ore drops. `RawCopper` / `RawIron` / `RawTungsten` smelt
   * via the crafting menu; `Coal` / `Diamond` are gem-form (no smelting).
   */
  RawCopper = 25,
  RawIron = 26,
  RawTungsten = 27,
  Coal = 28,
  Diamond = 29,
  /**
   * Refined ingots — produced by the smelting recipes. Tool recipes for the
   * copper / iron / tungsten tiers consume the matching ingot.
   */
  CopperIngot = 30,
  IronIngot = 31,
  TungstenIngot = 32,
  /**
   * Task 350 placed-light source. Crafted from 1 Stick + 1 Coal → 4 Torches
   * and placed via the standard right-click flow.
   */
  Torch = 33,
  /**
   * Task 370 first Utility item. Crafted from 1 Torch + 1 IronIngot → 1
   * Lantern. Equipped into the Utility slot — a worn item, not a placed
   * block. The renderer reads the equipped utility from each
   * `PlayerSnapshot` and attaches a warm point light at the player's head
   * when this ItemId is set.
   */
  Lantern = 34,
  /**
   * Task 390 felled-tree drop. Trees no longer scatter `Sticks` blocks in
   * a 3×3 around the broken tile — they drop 1-3 `Log` items (axe-tier
   * dependent) into the breaker's inventory. Logs are not placeable; they
   * craft into Wood blocks (1 Log → 1 Wood) or sticks (1 Log → 4 Sticks).
   */
  Log = 35,
  /**
   * Task 420 placeable storage. Crafted from 8 Wood; places `BlockType.Chest`
   * via the standard right-click flow.
   */
  Chest = 36,
  /**
   * Task 530 third tool family — shovels in five material tiers. Mining
   * `Sand`, `Dirt`, `Gravel`, `Grass` with the matching tier is fast and
   * drops normally; wrong tool falls back to the soft tool gate (task 520).
   */
  WoodShovel = 37,
  StoneShovel = 38,
  CopperShovel = 39,
  IronShovel = 40,
  TungstenShovel = 41,
  /**
   * Task 580 — Grass blocks are collectible. Breaking a Grass cell drops one
   * `Grass` (stackable like other ground-block items); placing puts the
   * matching `BlockType.Grass` back down via the standard right-click flow.
   */
  Grass = 42,
  /**
   * Task 140 bioluminescent mushroom drop. Placeable; right-click places a
   * `BlockType.LightMushroom` into a top-layer Air cell. Stacks like the
   * other decorative block items.
   */
  LightMushroom = 43,
  /**
   * Task 050 fifth tool family — swords in five material tiers. Combat
   * lands in task 070; for now equipping a sword has no in-game effect
   * beyond the slot being filled.
   */
  WoodSword = 44,
  StoneSword = 45,
  CopperSword = 46,
  IronSword = 47,
  TungstenSword = 48,
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
 * Identifies one of the equipment-slot mini-hotbar cells. Mirrors the proto
 * `ToolKind` enum and the server's `game::ToolKind`. Pickaxe and Axe land
 * with task 100; Utility (task 360) is the third slot, sitting next to
 * them; Shovel (task 530) is the fourth.
 */
export type ToolKind = "pickaxe" | "axe" | "utility" | "shovel" | "sword";

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

/**
 * `true` iff `item` is a utility-slot item (task 360). The lantern (task
 * 370) is the first such item; future utility items extend this predicate.
 */
export function isUtility(item: ItemId): boolean {
  return item === ItemId.Lantern;
}

/** True iff `item` is one of the five shovel tiers (task 530). */
export function isShovel(item: ItemId): boolean {
  return (
    item === ItemId.WoodShovel ||
    item === ItemId.StoneShovel ||
    item === ItemId.CopperShovel ||
    item === ItemId.IronShovel ||
    item === ItemId.TungstenShovel
  );
}

/** True iff `item` is one of the five sword tiers (task 050). */
export function isSword(item: ItemId): boolean {
  return (
    item === ItemId.WoodSword ||
    item === ItemId.StoneSword ||
    item === ItemId.CopperSword ||
    item === ItemId.IronSword ||
    item === ItemId.TungstenSword
  );
}

/** Tool family the item belongs to, or `null` for non-tool items. */
export function toolKindOf(item: ItemId): ToolKind | null {
  if (isPickaxe(item)) return "pickaxe";
  if (isAxe(item)) return "axe";
  if (isShovel(item)) return "shovel";
  if (isSword(item)) return "sword";
  if (isUtility(item)) return "utility";
  return null;
}

/**
 * Per-recipe advertise tier (task 100). `affordable` rows render normally
 * and click to craft; `partial-hint` rows render grayed at the bottom of
 * the panel and are click-inert — the player has at least one of any
 * ingredient but not enough to actually craft. Mirrors the server's
 * `game::RecipeAvailability` enum.
 */
export type RecipeAvailability = "affordable" | "partial-hint";

/** One advertised recipe row — a stable id + its current availability tier. */
export interface CraftableRecipe {
  readonly id: string;
  readonly availability: RecipeAvailability;
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
  private equippedUtilitySlot: number | null = null;
  private equippedShovelSlot: number | null = null;
  private equippedSwordSlot: number | null = null;
  private craftable: readonly CraftableRecipe[] = [];
  private listeners: Array<() => void> = [];

  constructor() {
    this.slots = Array.from({ length: INVENTORY_SIZE }, () => null);
  }

  /**
   * Recipes (task 100) the server most recently advertised for this
   * inventory. Each entry pairs a stable recipe id with its availability
   * tier (affordable vs. partial-hint). The list is sorted before storage
   * so the crafting panel's per-tier render order is stable across ticks.
   * The server still re-validates at `CraftRequest` time, so this is
   * purely an affordance filter.
   */
  getCraftableRecipes(): readonly CraftableRecipe[] {
    return this.craftable;
  }

  /**
   * Inventory slot index flagged as the equipped tool of `kind`, or `null`
   * if nothing is equipped. The cell at this index holds the tool — see
   * [`getEquipped`] for the resolved item.
   */
  getEquippedSlot(kind: ToolKind): number | null {
    switch (kind) {
      case "pickaxe":
        return this.equippedPickaxeSlot;
      case "axe":
        return this.equippedAxeSlot;
      case "utility":
        return this.equippedUtilitySlot;
      case "shovel":
        return this.equippedShovelSlot;
      case "sword":
        return this.equippedSwordSlot;
    }
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
   * `craftableRecipes` carries the server's per-tick advertise of recipes
   * (task 100). Each entry pairs a stable recipe id with its availability
   * tier — `affordable` rows are fully craftable; `partial-hint` rows are
   * the "you have some but not enough" tier. Sorted before storage so the
   * panel's per-tier render order is stable: affordable rows first
   * (lexically), partial-hint rows after (lexically).
   *
   * Accepts a plain string array for back-compat with tests that have not
   * yet migrated — every id in that shape is treated as `affordable`.
   */
  replaceFromWire(
    slots: readonly Slot[],
    equippedPickaxeSlot: number | null = null,
    equippedAxeSlot: number | null = null,
    craftableRecipes: readonly CraftableRecipe[] | readonly string[] = [],
    equippedUtilitySlot: number | null = null,
    equippedShovelSlot: number | null = null,
    equippedSwordSlot: number | null = null,
  ): void {
    if (slots.length !== INVENTORY_SIZE) {
      throw new Error(
        `inventory slot array length ${slots.length} != ${INVENTORY_SIZE}`,
      );
    }
    this.slots = slots.slice();
    this.equippedPickaxeSlot = normalizeEquipped(this.slots, equippedPickaxeSlot, "pickaxe");
    this.equippedAxeSlot = normalizeEquipped(this.slots, equippedAxeSlot, "axe");
    this.equippedUtilitySlot = normalizeEquipped(this.slots, equippedUtilitySlot, "utility");
    this.equippedShovelSlot = normalizeEquipped(this.slots, equippedShovelSlot, "shovel");
    this.equippedSwordSlot = normalizeEquipped(this.slots, equippedSwordSlot, "sword");
    this.craftable = sortCraftable(normalizeCraftable(craftableRecipes));
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

function normalizeCraftable(
  input: readonly CraftableRecipe[] | readonly string[],
): CraftableRecipe[] {
  return input.map((entry) =>
    typeof entry === "string"
      ? { id: entry, availability: "affordable" }
      : entry,
  );
}

function sortCraftable(entries: CraftableRecipe[]): CraftableRecipe[] {
  return [...entries].sort((a, b) => {
    if (a.availability !== b.availability) {
      return a.availability === "affordable" ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
