/**
 * Crafting overlay (task 100): a slide-in side panel that mirrors the
 * inventory panel's open/close lifecycle but anchors on the right edge of
 * the viewport. Each row in the panel is one currently-craftable recipe,
 * laid out as `[ingredients] → [output]`. Clicking a row ships a
 * `CraftRequest(recipe_id)` to the server; the server is authoritative and
 * the row disappears as soon as the next `InventoryUpdate`'s
 * `craftable_recipe_ids` list no longer contains that id.
 *
 * Network-free: this module reads the live `Inventory` mirror through a
 * `getInventory` thunk and subscribes to its change channel so the panel
 * re-renders on every `InventoryUpdate` without a round-trip.
 *
 * ## Submodules
 *
 * - [`./style`] — CSS injection + the panel-width constants.
 * - [`./row`] — pure DOM stamp-out for one recipe row.
 *
 * The list render order is `recipe.id` ascending (sort happens in
 * `Inventory::replaceFromWire`), so the panel doesn't reshuffle as the
 * inventory mutates around its edges.
 */

import type { Inventory } from "../../game/index.js";
import { recipeById } from "../../recipes.js";
import { makeRecipeRow } from "./row.js";
import { injectStyle } from "./style.js";

export interface CraftingUiOptions {
  /** Reads the current inventory mirror. Called on every render. */
  readonly getInventory: () => Inventory;
  /** Ship a `CraftRequest` for `recipeId` up to the server. */
  readonly sendCraft: (recipeId: string) => void;
}

export interface CraftingUiHandle {
  isOpen(): boolean;
  setOpen(open: boolean): void;
  toggle(): void;
  /** Force a re-render — exposed for tests; the live mirror notifies on its own. */
  render(): void;
  unmount(): void;
}

/**
 * Mount the crafting overlay. Returns a handle whose `unmount()` removes
 * all DOM and listeners, used by `runMain`'s teardown.
 */
export function mountCraftingUi(
  options: CraftingUiOptions,
): CraftingUiHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = "anarchy-crafting-root";

  const panel = document.createElement("aside");
  panel.className = "anarchy-crafting-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Crafting");
  root.appendChild(panel);

  let open = false;

  const render = (): void => {
    panel.replaceChildren();
    const ids = options.getInventory().getCraftableRecipeIds();
    if (ids.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anarchy-crafting-empty";
      empty.textContent = "No craftable recipes.";
      panel.appendChild(empty);
      return;
    }
    for (const id of ids) {
      const recipe = recipeById(id);
      if (!recipe) continue;
      const row = makeRecipeRow(recipe);
      row.addEventListener("click", () => options.sendCraft(recipe.id));
      panel.appendChild(row);
    }
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    panel.classList.toggle("open", open);
  };

  const unsubscribe = options.getInventory().subscribe(render);

  // Stop pointer events from reaching `window` so the bootstrap-level
  // mousedown / contextmenu handlers don't fire destroy / place when a
  // click lands on the crafting panel.
  for (const ev of ["mousedown", "mouseup", "click", "contextmenu"] as const) {
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }

  document.body.appendChild(root);
  render();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    render,
    unmount: () => {
      unsubscribe();
      root.remove();
    },
  };
}
