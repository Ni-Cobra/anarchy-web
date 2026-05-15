/**
 * Crafting overlay (task 100): a slide-in side panel that mirrors the
 * inventory panel's open/close lifecycle but anchors on the right edge of
 * the viewport. Each row in the panel is one server-advertised recipe,
 * laid out as `[ingredients] → [output]`. Clicking an affordable row
 * ships a `CraftRequest(recipe_id)` to the server; the server is
 * authoritative and the row updates on the next `InventoryUpdate`.
 *
 * Network-free: this module reads the live `Inventory` mirror through a
 * `getInventory` thunk and subscribes to its change channel so the panel
 * re-renders on every `InventoryUpdate` without a round-trip.
 *
 * ## Affordability tiering (task 100)
 *
 * The server advertises recipes in two tiers — `affordable` (fully
 * craftable now) and `partial-hint` (the player has at least one of any
 * ingredient but not enough to actually craft). Affordable rows sort
 * first; partial-hint rows fall to the bottom of the panel and render
 * grayed + click-inert. Recipes the player has zero relevant ingredients
 * for stay hidden — the partial-hint tier is meant as a "you're getting
 * closer" affordance, not a recipe browser.
 *
 * ## Submodules
 *
 * - [`./style`] — CSS injection + the panel-width constants.
 * - [`./row`] — pure DOM stamp-out for one recipe row.
 *
 * ## Hover anchoring (task 460)
 *
 * Rows live inside a `.anarchy-crafting-list` wrapper so the panel's
 * slide-in transform is decoupled from a vertical `translateY` we apply to
 * keep the currently-hovered row pinned to its viewport position across
 * inventory churn. If the hovered recipe stops being craftable, it stays
 * in the list as a disabled "orphan" until the cursor moves off, so a
 * click that lands mid-update never crafts a different recipe.
 *
 * ## Chrome stability (task 565)
 *
 * The panel itself owns only the static chrome (border, radius, padding,
 * slide-in transform). Scrolling lives one layer deeper on
 * `.anarchy-crafting-scroll` so the panel bounds don't reflow when the
 * row set changes, and `scrollbar-gutter: stable` on that wrapper
 * reserves the scrollbar lane so toggling overflow doesn't shift the row
 * strip horizontally. The hover anchor's `translateY` continues to live
 * on the innermost `.anarchy-crafting-list` so it operates inside the
 * scroll viewport.
 */

import type { CraftableRecipe, Inventory } from "../../game/index.js";
import { recipeById } from "../../recipes.js";
import { attachTooltip, type TooltipHandle } from "../tooltip.js";
import { maxCraftCount } from "./max_craft.js";
import { makeRecipeRow } from "./row.js";
import { injectStyle } from "./style.js";
import { makeRecipeTooltip } from "./tooltip.js";

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

  const scroll = document.createElement("div");
  scroll.className = "anarchy-crafting-scroll";
  panel.appendChild(scroll);

  const list = document.createElement("div");
  list.className = "anarchy-crafting-list";
  scroll.appendChild(list);

  let open = false;
  let hoveredRecipeId: string | null = null;
  // Accumulated translateY (in CSS pixels) on `list` that keeps the hovered
  // row visually pinned across re-renders. Reset to 0 when no row is hovered.
  let anchorOffset = 0;
  // Per-row tooltip handles; replaced wholesale on every render so each row
  // gets a fresh `attachTooltip` against its live recipe + inventory thunk.
  const tooltipHandles: TooltipHandle[] = [];
  const detachAllTooltips = (): void => {
    for (const h of tooltipHandles) h.detach();
    tooltipHandles.length = 0;
  };

  const applyAnchor = (): void => {
    list.style.transform = anchorOffset === 0 ? "" : `translateY(${anchorOffset}px)`;
  };

  const findRow = (id: string): HTMLElement | null =>
    list.querySelector<HTMLElement>(
      `.anarchy-crafting-row[data-recipe-id="${id}"]`,
    );

  const render = (): void => {
    const natural = options.getInventory().getCraftableRecipes();
    let display: readonly CraftableRecipe[] = natural;
    let orphanId: string | null = null;
    if (
      hoveredRecipeId !== null &&
      !natural.some((r) => r.id === hoveredRecipeId)
    ) {
      orphanId = hoveredRecipeId;
      display = insertOrphan(natural, hoveredRecipeId);
    }

    // Capture the hovered row's viewport-y *before* the DOM mutates so we
    // can re-pin it after re-rendering. If nothing is hovered, drop any
    // residual anchor offset so the next render lays out naturally.
    let prevTop: number | null = null;
    if (hoveredRecipeId !== null) {
      const prevRow = findRow(hoveredRecipeId);
      if (prevRow) prevTop = prevRow.getBoundingClientRect().top;
    } else if (anchorOffset !== 0) {
      anchorOffset = 0;
      applyAnchor();
    }

    detachAllTooltips();
    list.replaceChildren();
    if (display.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anarchy-crafting-empty";
      empty.textContent = "No craftable recipes.";
      list.appendChild(empty);
      return;
    }
    const inventory = options.getInventory();
    for (const entry of display) {
      const recipe = recipeById(entry.id);
      if (!recipe) continue;
      const partialHint = entry.availability === "partial-hint";
      const row = makeRecipeRow(
        recipe,
        maxCraftCount(recipe, inventory),
        partialHint,
      );
      if (entry.id === orphanId) {
        row.classList.add("uncraftable");
        row.setAttribute("aria-disabled", "true");
      }
      const inert = partialHint || entry.id === orphanId;
      row.addEventListener("click", () => {
        if (inert) return;
        options.sendCraft(recipe.id);
      });
      tooltipHandles.push(
        attachTooltip(row, () => makeRecipeTooltip(recipe, options.getInventory())),
      );
      list.appendChild(row);
    }

    if (hoveredRecipeId !== null && prevTop !== null) {
      const newRow = findRow(hoveredRecipeId);
      if (newRow) {
        const newTop = newRow.getBoundingClientRect().top;
        const delta = prevTop - newTop;
        if (delta !== 0) {
          anchorOffset += delta;
          applyAnchor();
        }
      }
    }
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    panel.classList.toggle("open", open);
  };

  const setHovered = (next: string | null): void => {
    if (next === hoveredRecipeId) return;
    hoveredRecipeId = next;
    render();
  };

  // Hover is tracked at the document level rather than via panel-scoped
  // mouseenter/leave: in headless Chromium under Playwright, leaving the
  // panel in a single `mouse.move(x, y)` step doesn't reliably dispatch
  // `mouseleave` on the panel. A document `mousemove` listener catches
  // both transitions — into and out of the panel — from the same signal.
  // `panel.contains(target)` keeps the check scoped to our own DOM.
  const onDocMouseMove = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !panel.contains(target)) {
      setHovered(null);
      return;
    }
    const row = target.closest<HTMLElement>(".anarchy-crafting-row");
    setHovered(row?.dataset.recipeId ?? null);
  };
  const onPanelMouseLeave = (): void => {
    setHovered(null);
  };

  const unsubscribe = options.getInventory().subscribe(render);

  // Stop pointer events from reaching `window` so the bootstrap-level
  // mousedown / contextmenu handlers don't fire destroy / place when a
  // click lands on the crafting panel. `contextmenu` also gets
  // `preventDefault` so the browser's native context menu doesn't
  // surface over the panel.
  for (const ev of ["mousedown", "mouseup", "click"] as const) {
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }
  panel.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  panel.addEventListener("mouseleave", onPanelMouseLeave);
  document.addEventListener("mousemove", onDocMouseMove);

  document.body.appendChild(root);
  render();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    render,
    unmount: () => {
      unsubscribe();
      detachAllTooltips();
      document.removeEventListener("mousemove", onDocMouseMove);
      root.remove();
    },
  };
}

/**
 * Insert an orphan recipe id into the natural advertise list at its
 * lexically-sorted position inside the affordable tier (orphans always
 * read as "this used to be craftable" — they go above the partial-hint
 * tier so the hover anchor doesn't drop the row past the gray section).
 */
function insertOrphan(
  arr: readonly CraftableRecipe[],
  id: string,
): CraftableRecipe[] {
  const orphan: CraftableRecipe = { id, availability: "affordable" };
  const out: CraftableRecipe[] = [];
  let inserted = false;
  for (const entry of arr) {
    if (!inserted && entry.availability === "partial-hint") {
      out.push(orphan);
      inserted = true;
    } else if (
      !inserted &&
      entry.availability === "affordable" &&
      id < entry.id
    ) {
      out.push(orphan);
      inserted = true;
    }
    out.push(entry);
  }
  if (!inserted) out.push(orphan);
  return out;
}
