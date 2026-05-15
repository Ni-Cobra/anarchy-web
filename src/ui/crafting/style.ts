/**
 * CSS injection for the crafting overlay (task 100). The crafting panel
 * mirrors the inventory side panel's positioning + animation so the two
 * read as one widget when both are open: the inventory slides in from the
 * left, the crafting panel slides in from the right, both vertically
 * centered at the same `top: 50%` anchor.
 *
 * Pixel constants are co-located with the inventory style module so a
 * future layout retune touches one file. Per-row layout is driven by flex
 * containers so a recipe with many ingredient stacks wraps gracefully
 * inside its half of the row without spilling across the arrow.
 */

import { PANEL_GAP_PX, PANEL_PAD_PX, SLOT_PX } from "../inventory/style.js";

export const STYLE_ID = "anarchy-crafting-style";

/**
 * Width of one ingredient / output icon in a recipe row. Sized so two
 * stacks plus their gap fit on one line per side at the panel's stock
 * width — a recipe with three or more stacks per side flex-wraps inside
 * its half rather than pushing the arrow off-center.
 */
export const RECIPE_ICON_PX = 44;

/**
 * Width of the crafting panel (CSS pixels). Re-uses the inventory grid's
 * dimensions (5-slot equivalent) so the panel reads at the same visual
 * weight as the inventory side panel. The two halves are flex-1 so they
 * share the leftover space evenly; rows wider than that still flex-wrap
 * inside their half.
 */
export const CRAFTING_PANEL_WIDTH_PX = 5 * SLOT_PX + 4 * PANEL_GAP_PX + PANEL_PAD_PX * 2;

const STYLE = `
  #anarchy-crafting-root {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 8500;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
  }
  #anarchy-crafting-root > * { pointer-events: auto; }
  .anarchy-crafting-panel {
    position: absolute;
    top: 50%;
    right: 0;
    transform: translate(100%, -50%);
    transition: transform 0.15s ease-out;
    width: ${CRAFTING_PANEL_WIDTH_PX}px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-right: none;
    border-radius: 8px 0 0 8px;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
    box-sizing: border-box;
    padding: ${PANEL_PAD_PX}px;
  }
  .anarchy-crafting-panel.open { transform: translate(0, -50%); }
  /*
   * Scroll viewport (task 565). Sits between the panel chrome and the row
   * list so the panel bounds don't reflow when the row set changes:
   * - flex: 1 1 auto + min-height: 0 lets the wrapper shrink inside the
   *   panel's max-height and trigger its own overflow rather than
   *   pushing the panel border around.
   * - scrollbar-gutter: stable reserves the scrollbar lane so the row
   *   strip doesn't shift horizontally when content crosses the overflow
   *   threshold.
   */
  .anarchy-crafting-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
  /*
   * Inner wrapper that owns the row flow. The hover-anchor logic in
   * index.ts applies a translateY here (not on the panel) so the slide-in
   * transition above is undisturbed.
   */
  .anarchy-crafting-list {
    display: flex;
    flex-direction: column;
    gap: ${PANEL_GAP_PX}px;
  }
  .anarchy-crafting-empty {
    color: rgba(240, 240, 240, 0.55);
    font-size: 13px;
    text-align: center;
    padding: 8px 4px;
  }
  .anarchy-crafting-row {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    cursor: pointer;
    box-sizing: border-box;
    transition: background 0.1s ease-out, border-color 0.1s ease-out;
  }
  .anarchy-crafting-row:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.25);
  }
  .anarchy-crafting-row:focus-visible {
    outline: 2px solid #5aa0ff;
    outline-offset: 1px;
  }
  /*
   * Hovered recipe that just stopped being craftable (task 460). It stays
   * in the list so a click already on its way doesn't end up crafting a
   * different row; visually grayed and inert until the cursor leaves.
   */
  .anarchy-crafting-row.uncraftable {
    opacity: 0.4;
    filter: grayscale(0.8);
    cursor: not-allowed;
  }
  .anarchy-crafting-row.uncraftable:hover {
    background: rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.1);
  }
  /*
   * Partial-hint rows (task 100). The server advertises recipes the
   * player has *some* of an ingredient toward but cannot yet craft;
   * they sort to the bottom of the panel and render desaturated so the
   * player reads "you're partway here" without confusing them with the
   * full-color affordable rows above. Click is a no-op (gated in
   * index.ts) and the hover highlight is suppressed so the row reads
   * as inert.
   */
  .anarchy-crafting-row.partial-hint {
    opacity: 0.45;
    filter: grayscale(0.8);
    cursor: not-allowed;
  }
  .anarchy-crafting-row.partial-hint:hover {
    background: rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .anarchy-crafting-side {
    display: flex;
    flex: 1 1 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .anarchy-crafting-side.right { justify-content: flex-end; }
  .anarchy-crafting-stack {
    position: relative;
    width: ${RECIPE_ICON_PX}px;
    height: ${RECIPE_ICON_PX}px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }
  .anarchy-crafting-stack-icon {
    width: 70%;
    height: 70%;
    border-radius: 2px;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .anarchy-crafting-stack-count {
    position: absolute;
    bottom: 2px;
    right: 4px;
    font-size: 13px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
    pointer-events: none;
  }
  /*
   * Column wrapper for the arrow glyph + the max-craft-count badge below
   * (task 490). Sits between the two sides as a flex item so the arrow
   * stays centered horizontally while the count tucks directly beneath.
   */
  .anarchy-crafting-arrow-cell {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 0 2px;
    user-select: none;
  }
  .anarchy-crafting-arrow {
    color: rgba(240, 240, 240, 0.7);
    font-size: 22px;
    line-height: 1;
  }
  .anarchy-crafting-arrow-count {
    font-size: 11px;
    font-weight: 600;
    color: rgba(240, 240, 240, 0.6);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  /*
   * Recipe hover tooltip (task 470). Rendered inside the shared
   * anarchy-tooltip node — the tooltip primitive owns the background,
   * border, and padding, so this only styles the layout of the recipe
   * body (title row above an ingredient list).
   */
  .anarchy-crafting-tooltip {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .anarchy-crafting-tooltip-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }
  .anarchy-crafting-tooltip-ingredients {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .anarchy-crafting-tooltip-ingredient {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .anarchy-crafting-tooltip-need {
    min-width: 22px;
    text-align: right;
    color: rgba(240, 240, 240, 0.75);
  }
  .anarchy-crafting-tooltip-icon {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    border-radius: 2px;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.4);
  }
  .anarchy-crafting-tooltip-name {
    flex: 1 1 auto;
    white-space: nowrap;
  }
  .anarchy-crafting-tooltip-have {
    color: rgba(240, 240, 240, 0.55);
    font-variant-numeric: tabular-nums;
  }
  .anarchy-crafting-tooltip-have.short {
    color: #e07c7c;
  }
`;

export function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}
