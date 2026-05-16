/**
 * Client-side mirror of the server's crafting recipe table (task 090).
 *
 * The wire surface only ships *recipe ids* — stable strings like
 * `"wood-pickaxe"` — so the client can render the ingredient/output preview
 * for each currently-craftable recipe without any wire growth. This module
 * is the lookup table that turns those ids into the data the crafting panel
 * paints. Mirrors `anarchy-server/src/game/player/crafting.rs::RECIPES`
 * exactly; the two tables are the only redundant copy in the project (per
 * the charter: "Avoid redundancy *except* across the client/server
 * boundary").
 *
 * Lives at the top of `src/` (alongside `textures.ts` / `item_names.ts`)
 * because it straddles the network mirror (the `Inventory` ships recipe
 * ids that need this lookup) and the UI (`ui/crafting/` paints the rows).
 */

import { ItemId } from "./game/index.js";

/** One ingredient or output of a recipe. */
export interface RecipeStack {
  readonly item: ItemId;
  readonly count: number;
}

/**
 * One recipe row: a stable string id, the pooled ingredients required, and
 * the single-stack output the server inserts on a successful craft. The
 * client paints the row as `[ingredients] → [output]`; clicking it ships a
 * `CraftRequest(id)` to the server, which is authoritative.
 */
export interface Recipe {
  readonly id: string;
  readonly ingredients: readonly RecipeStack[];
  readonly output: RecipeStack;
}

/**
 * Recipe table. Order matches the server table so a recipe id served by
 * the server resolves cheaply via [`recipeById`]. Keep in lockstep with
 * `crafting.rs::RECIPES` — when a new recipe lands server-side, mirror it
 * here in the same iteration (the charter pins this kind of cross-boundary
 * redundancy as expected).
 */
export const RECIPES: readonly Recipe[] = [
  {
    id: "sticks",
    ingredients: [{ item: ItemId.Wood, count: 1 }],
    output: { item: ItemId.Stick, count: 4 },
  },
  // Task 390: trees drop `Log` items now. Logs craft into Wood blocks
  // (1:1) and into Sticks (1 Log → 4 Sticks).
  {
    id: "wood-from-log",
    ingredients: [{ item: ItemId.Log, count: 1 }],
    output: { item: ItemId.Wood, count: 1 },
  },
  {
    id: "sticks-from-log",
    ingredients: [{ item: ItemId.Log, count: 1 }],
    output: { item: ItemId.Stick, count: 4 },
  },
  // Task 580: wood-tier pickaxe + shovel now take raw `Log`s rather than
  // refined `Wood` planks (the wood-axe recipe still uses planks so the
  // shape stays asymmetric).
  {
    id: "wood-pickaxe",
    ingredients: [
      { item: ItemId.Log, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.WoodPickaxe, count: 1 },
  },
  {
    id: "wood-axe",
    ingredients: [
      { item: ItemId.Wood, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.WoodAxe, count: 1 },
  },
  {
    id: "stone-pickaxe",
    ingredients: [
      { item: ItemId.Stone, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.StonePickaxe, count: 1 },
  },
  {
    id: "stone-axe",
    ingredients: [
      { item: ItemId.Stone, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.StoneAxe, count: 1 },
  },
  // Task 150 smelting recipes — 1 raw → 1 ingot.
  {
    id: "copper-ingot",
    ingredients: [{ item: ItemId.RawCopper, count: 1 }],
    output: { item: ItemId.CopperIngot, count: 1 },
  },
  {
    id: "iron-ingot",
    ingredients: [{ item: ItemId.RawIron, count: 1 }],
    output: { item: ItemId.IronIngot, count: 1 },
  },
  {
    id: "tungsten-ingot",
    ingredients: [{ item: ItemId.RawTungsten, count: 1 }],
    output: { item: ItemId.TungstenIngot, count: 1 },
  },
  // Task 150 tool-tier upgrades.
  {
    id: "copper-pickaxe",
    ingredients: [
      { item: ItemId.CopperIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.CopperPickaxe, count: 1 },
  },
  {
    id: "copper-axe",
    ingredients: [
      { item: ItemId.CopperIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.CopperAxe, count: 1 },
  },
  {
    id: "iron-pickaxe",
    ingredients: [
      { item: ItemId.IronIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.IronPickaxe, count: 1 },
  },
  {
    id: "iron-axe",
    ingredients: [
      { item: ItemId.IronIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.IronAxe, count: 1 },
  },
  {
    id: "tungsten-pickaxe",
    ingredients: [
      { item: ItemId.TungstenIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.TungstenPickaxe, count: 1 },
  },
  {
    id: "tungsten-axe",
    ingredients: [
      { item: ItemId.TungstenIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.TungstenAxe, count: 1 },
  },
  // Task 350 light-source recipe: 1 Stick + 1 Coal → 4 Torches.
  {
    id: "torch",
    ingredients: [
      { item: ItemId.Stick, count: 1 },
      { item: ItemId.Coal, count: 1 },
    ],
    output: { item: ItemId.Torch, count: 4 },
  },
  // Task 370 first Utility item: 1 Torch + 1 IronIngot → 1 Lantern.
  {
    id: "lantern",
    ingredients: [
      { item: ItemId.Torch, count: 1 },
      { item: ItemId.IronIngot, count: 1 },
    ],
    output: { item: ItemId.Lantern, count: 1 },
  },
  // Task 420 placeable storage: 8 Wood → 1 Chest.
  {
    id: "chest",
    ingredients: [{ item: ItemId.Wood, count: 8 }],
    output: { item: ItemId.Chest, count: 1 },
  },
  // Task 530 shovel ladder — mirrors the axe ladder exactly.
  // Task 580: wood-tier shovel takes raw `Log`s — see the wood-pickaxe note.
  {
    id: "wood-shovel",
    ingredients: [
      { item: ItemId.Log, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.WoodShovel, count: 1 },
  },
  {
    id: "stone-shovel",
    ingredients: [
      { item: ItemId.Stone, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.StoneShovel, count: 1 },
  },
  {
    id: "copper-shovel",
    ingredients: [
      { item: ItemId.CopperIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.CopperShovel, count: 1 },
  },
  {
    id: "iron-shovel",
    ingredients: [
      { item: ItemId.IronIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.IronShovel, count: 1 },
  },
  {
    id: "tungsten-shovel",
    ingredients: [
      { item: ItemId.TungstenIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.TungstenShovel, count: 1 },
  },
  // Task 050 sword ladder — mirrors the pickaxe / shovel shape exactly
  // (3 of the head material + 2 sticks → 1 sword). Wood-sword consumes
  // raw `Log`s for symmetry with the wood-pickaxe / wood-shovel path.
  {
    id: "wood-sword",
    ingredients: [
      { item: ItemId.Log, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.WoodSword, count: 1 },
  },
  {
    id: "stone-sword",
    ingredients: [
      { item: ItemId.Stone, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.StoneSword, count: 1 },
  },
  {
    id: "copper-sword",
    ingredients: [
      { item: ItemId.CopperIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.CopperSword, count: 1 },
  },
  {
    id: "iron-sword",
    ingredients: [
      { item: ItemId.IronIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.IronSword, count: 1 },
  },
  {
    id: "tungsten-sword",
    ingredients: [
      { item: ItemId.TungstenIngot, count: 3 },
      { item: ItemId.Stick, count: 2 },
    ],
    output: { item: ItemId.TungstenSword, count: 1 },
  },
];

const RECIPES_BY_ID: ReadonlyMap<string, Recipe> = new Map(
  RECIPES.map((r) => [r.id, r]),
);

/**
 * Lookup a recipe by stable id. Returns `undefined` if the id is unknown
 * — the crafting UI ignores unknown ids defensively so a server that adds
 * a recipe ahead of a client rebuild simply hides the row instead of
 * throwing on render.
 */
export function recipeById(id: string): Recipe | undefined {
  return RECIPES_BY_ID.get(id);
}
