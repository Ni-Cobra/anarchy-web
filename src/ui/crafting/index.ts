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

import type { Inventory } from "../../game/index.js";
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
    const naturalIds = options.getInventory().getCraftableRecipeIds();
    let displayIds: readonly string[] = naturalIds;
    let orphanId: string | null = null;
    if (hoveredRecipeId !== null && !naturalIds.includes(hoveredRecipeId)) {
      orphanId = hoveredRecipeId;
      displayIds = insertSorted(naturalIds, hoveredRecipeId);
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
    if (displayIds.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anarchy-crafting-empty";
      empty.textContent = "No craftable recipes.";
      list.appendChild(empty);
      return;
    }
    const inventory = options.getInventory();
    for (const id of displayIds) {
      const recipe = recipeById(id);
      if (!recipe) continue;
      const row = makeRecipeRow(recipe, maxCraftCount(recipe, inventory));
      if (id === orphanId) {
        row.classList.add("uncraftable");
        row.setAttribute("aria-disabled", "true");
      }
      row.addEventListener("click", () => {
        if (id === orphanId) return;
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

function insertSorted(arr: readonly string[], value: string): string[] {
  const out: string[] = [];
  let inserted = false;
  for (const id of arr) {
    if (!inserted && value < id) {
      out.push(value);
      inserted = true;
    }
    out.push(id);
  }
  if (!inserted) out.push(value);
  return out;
}
