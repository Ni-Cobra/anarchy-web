/**
 * Pure DOM helpers for one crafting recipe row. The orchestration in
 * `index.ts` builds rows from the live recipe id list; this module just
 * stamps out the DOM for `[ingredients] → [output]` without any state or
 * listeners.
 *
 * Both sides flex-wrap inside their half of the row, so a recipe with many
 * ingredient stacks (today: at most two; future tiers may grow) lays out
 * left-justified on the ingredient side and right-justified on the output
 * side, never spilling past the centered arrow.
 */

import { itemDisplayName } from "../../item_names.js";
import type { Recipe, RecipeStack } from "../../recipes.js";
import { textureUrlForItem } from "../../textures.js";

/**
 * Build the button-shaped row for `recipe`. Caller wires the `click`
 * handler — the row itself is otherwise inert (no internal state).
 */
export function makeRecipeRow(recipe: Recipe): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "anarchy-crafting-row";
  row.dataset.recipeId = recipe.id;
  row.setAttribute(
    "aria-label",
    recipeAriaLabel(recipe),
  );

  const left = document.createElement("div");
  left.className = "anarchy-crafting-side left";
  for (const stack of recipe.ingredients) {
    left.appendChild(makeStack(stack));
  }

  const arrow = document.createElement("span");
  arrow.className = "anarchy-crafting-arrow";
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");

  const right = document.createElement("div");
  right.className = "anarchy-crafting-side right";
  right.appendChild(makeStack(recipe.output));

  row.appendChild(left);
  row.appendChild(arrow);
  row.appendChild(right);
  return row;
}

/**
 * One ingredient / output icon + count badge. The icon reuses
 * `textureUrlForItem` so a stack and its inventory cell share a
 * pixel-perfect identity. Counts ≥ 2 paint a small badge in the bottom-
 * right; counts of 1 stay badge-less for visual quiet.
 */
function makeStack(stack: RecipeStack): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "anarchy-crafting-stack";
  const icon = document.createElement("div");
  icon.className = "anarchy-crafting-stack-icon";
  const url = textureUrlForItem(stack.item);
  if (url) {
    icon.style.backgroundImage = `url("${url}")`;
    icon.style.backgroundSize = "100% 100%";
    icon.style.backgroundRepeat = "no-repeat";
    icon.style.imageRendering = "pixelated";
  } else {
    icon.style.background = "#888";
  }
  cell.appendChild(icon);
  if (stack.count > 1) {
    const count = document.createElement("span");
    count.className = "anarchy-crafting-stack-count";
    count.textContent = String(stack.count);
    cell.appendChild(count);
  }
  return cell;
}

function recipeAriaLabel(recipe: Recipe): string {
  const lhs = recipe.ingredients
    .map((s) => `${s.count} ${itemDisplayName(s.item)}`)
    .join(", ");
  const rhs = `${recipe.output.count} ${itemDisplayName(recipe.output.item)}`;
  return `Craft: ${lhs} to ${rhs}`;
}
