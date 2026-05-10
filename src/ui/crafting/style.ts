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
    overflow-y: auto;
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-right: none;
    border-radius: 8px 0 0 8px;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
    box-sizing: border-box;
    padding: ${PANEL_PAD_PX}px;
    display: flex;
    flex-direction: column;
    gap: ${PANEL_GAP_PX}px;
  }
  .anarchy-crafting-panel.open { transform: translate(0, -50%); }
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
  .anarchy-crafting-arrow {
    flex: 0 0 auto;
    color: rgba(240, 240, 240, 0.7);
    font-size: 22px;
    line-height: 1;
    padding: 0 2px;
    user-select: none;
  }
`;

export function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}
