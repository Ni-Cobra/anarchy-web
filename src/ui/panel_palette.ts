/**
 * Shared visual tokens for inventory-style overlay panels — the player's
 * inventory side panel ([`inventory/style.ts`]) and each chest panel
 * ([`chest/panel_manager.ts`]). Both panels lifted these out of their
 * per-module style strings (task 600) so a future palette tweak lands
 * once and the two panels read as one UI family when sitting side by
 * side.
 *
 * The chest panel still owns a wood-toned header (background + title
 * color + active-panel accent border) as the semantic chest-vs-inventory
 * differentiator. Everything below — panel body chrome, cell frame and
 * hover, count badge, drag-source / split-source highlights — is shared.
 */

export const PANEL_BACKGROUND = "rgba(20, 24, 30, 0.96)";
export const PANEL_BORDER_COLOR = "rgba(255, 255, 255, 0.08)";
export const PANEL_BORDER = `1px solid ${PANEL_BORDER_COLOR}`;
export const PANEL_BORDER_RADIUS_PX = 8;

export const CELL_BACKGROUND = "rgba(0, 0, 0, 0.35)";
export const CELL_BORDER_COLOR = "rgba(255, 255, 255, 0.12)";
export const CELL_BORDER = `1px solid ${CELL_BORDER_COLOR}`;
export const CELL_BORDER_RADIUS_PX = 4;
export const CELL_HOVER_BORDER_COLOR = "rgba(255, 255, 255, 0.5)";

export const CELL_DRAG_SOURCE_OPACITY = "0.4";
export const CELL_SPLIT_SOURCE_BORDER_COLOR = "#ffd34a";
export const CELL_SPLIT_SOURCE_INSET_SHADOW =
  "0 0 0 2px rgba(255, 211, 74, 0.5) inset";

/**
 * Slot icon embossing — applied to the inventory-icon div and the chest
 * slot's `<img>` so the cell contents read consistently across both
 * panels. The inset shadow lifts the icon off the cell background by
 * one pixel; the rounded corner softens the square edge.
 */
export const ICON_BORDER_RADIUS_PX = 3;
export const ICON_INSET_SHADOW = "inset 0 0 0 1px rgba(0, 0, 0, 0.35)";

export const COUNT_FONT_SIZE_PX = 12;
export const COUNT_FONT_WEIGHT = "600";
export const COUNT_TEXT_SHADOW = "0 1px 2px rgba(0, 0, 0, 0.8)";
