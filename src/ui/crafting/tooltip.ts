/**
 * Tooltip body for one crafting recipe (task 470). Shown when the cursor
 * hovers a recipe row in the crafting panel; communicates the recipe's
 * output, its required ingredient stacks, and (cheaply) the player's
 * current have-count for each ingredient so the player can see at a
 * glance what the craft takes.
 *
 * Built as a plain DOM tree and passed to `attachTooltip` via the
 * `TooltipContent` HTMLElement branch. Built fresh on every show / move
 * — the recipe table is tiny so the per-event allocations are
 * negligible, and reading the live inventory keeps have-counts current
 * as the player gathers ingredients without leaving the panel.
 */

import type { Inventory, ItemId } from "../../game/index.js";
import { itemDisplayName } from "../../item_names.js";
import type { Recipe } from "../../recipes.js";
import { textureUrlForItem } from "../../textures.js";

export function makeRecipeTooltip(
  recipe: Recipe,
  inventory: Inventory,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "anarchy-crafting-tooltip";

  const title = document.createElement("div");
  title.className = "anarchy-crafting-tooltip-title";
  title.appendChild(makeIcon(recipe.output.item));
  const titleName = document.createElement("span");
  titleName.className = "anarchy-crafting-tooltip-name";
  titleName.textContent =
    recipe.output.count > 1
      ? `${itemDisplayName(recipe.output.item)} × ${recipe.output.count}`
      : itemDisplayName(recipe.output.item);
  title.appendChild(titleName);
  root.appendChild(title);

  const list = document.createElement("div");
  list.className = "anarchy-crafting-tooltip-ingredients";
  for (const stack of recipe.ingredients) {
    list.appendChild(makeIngredientRow(stack.item, stack.count, inventory));
  }
  root.appendChild(list);
  return root;
}

function makeIngredientRow(
  item: ItemId,
  required: number,
  inventory: Inventory,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "anarchy-crafting-tooltip-ingredient";

  const need = document.createElement("span");
  need.className = "anarchy-crafting-tooltip-need";
  need.textContent = `${required} ×`;
  row.appendChild(need);

  row.appendChild(makeIcon(item));

  const name = document.createElement("span");
  name.className = "anarchy-crafting-tooltip-name";
  name.textContent = itemDisplayName(item);
  row.appendChild(name);

  const have = inventory.countOf(item);
  const haveEl = document.createElement("span");
  haveEl.className = "anarchy-crafting-tooltip-have";
  if (have < required) haveEl.classList.add("short");
  haveEl.textContent = `(have ${have})`;
  row.appendChild(haveEl);

  return row;
}

function makeIcon(item: ItemId): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "anarchy-crafting-tooltip-icon";
  const url = textureUrlForItem(item);
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = "100% 100%";
    el.style.backgroundRepeat = "no-repeat";
    el.style.imageRendering = "pixelated";
  } else {
    el.style.background = "#888";
  }
  return el;
}
