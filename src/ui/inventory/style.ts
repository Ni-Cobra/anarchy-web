/**
 * CSS injection for the inventory overlay. The component owns its style
 * tag (one per page; identity check by `STYLE_ID`) so the rest of the
 * page stays untouched. The pixel constants are exported for the layout
 * machinery (panel width derives from `SLOT_PX`/`PANEL_GAP_PX`/etc.).
 *
 * Visual tokens (panel background, cell frame, hover, count badge,
 * drag/split highlights) live in `../panel_palette.ts` and are shared
 * with the chest panel (task 600) so the two panels read as one UI
 * family.
 */

import {
  CELL_BACKGROUND,
  CELL_BORDER,
  CELL_BORDER_RADIUS_PX,
  CELL_DRAG_SOURCE_OPACITY,
  CELL_HOVER_BORDER_COLOR,
  CELL_SPLIT_SOURCE_BORDER_COLOR,
  CELL_SPLIT_SOURCE_INSET_SHADOW,
  COUNT_FONT_SIZE_PX,
  COUNT_FONT_WEIGHT,
  COUNT_TEXT_SHADOW,
  ICON_BORDER_RADIUS_PX,
  ICON_INSET_SHADOW,
  PANEL_BACKGROUND,
  PANEL_BORDER,
  PANEL_BORDER_RADIUS_PX,
} from "../panel_palette.js";

export const STYLE_ID = "anarchy-inventory-style";

export const SLOT_PX = 48;
export const HOTBAR_GAP_PX = 4;
export const PANEL_PAD_PX = 16;
export const PANEL_GAP_PX = 4;
export const PANEL_COLS = 4;
export const PANEL_WIDTH_PX =
  PANEL_COLS * SLOT_PX + (PANEL_COLS - 1) * PANEL_GAP_PX + PANEL_PAD_PX * 2;

/**
 * Gap (in CSS pixels) between the main hotbar and the two equipment slots
 * (task 100). The equipment cells reuse the hotbar's `SLOT_PX` size so
 * the mini-hotbar reads as a sibling cluster without a separate scale.
 */
export const EQUIP_GAP_PX = 16;

const STYLE = `
  #anarchy-inventory-root {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 8500;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
  }
  #anarchy-inventory-root > * { pointer-events: auto; }
  .anarchy-hotbar-row {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: ${EQUIP_GAP_PX}px;
    align-items: center;
    pointer-events: none;
  }
  .anarchy-hotbar-row > * { pointer-events: auto; }
  .anarchy-hotbar,
  .anarchy-equipment-bar {
    display: flex;
    gap: ${HOTBAR_GAP_PX}px;
    padding: 6px;
    background: rgba(20, 24, 30, 0.78);
    border: ${PANEL_BORDER};
    border-radius: ${PANEL_BORDER_RADIUS_PX}px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  /* Equipment slots are circular to read as visually distinct from the
     square inventory / hotbar cells, and they're mouse-inert (task 60)
     — the auto-equip paths and the panel-cell toggle from task 570 are
     the only fillers. The double-class selector (specificity 0,2,0)
     beats the bare .anarchy-inventory-slot rule below (0,1,0), which
     otherwise wins on source order and re-imposes the 4px corner — that
     was task 010's bug. overflow: hidden clips any inner element
     (today's icon, tomorrow's tint background) to the circle, and
     cursor: default signals the lack of interactivity. */
  .anarchy-inventory-slot.anarchy-equipment-slot {
    border-radius: 50%;
    overflow: hidden;
    cursor: default;
  }
  .anarchy-equipment-slot.empty .anarchy-inventory-icon {
    opacity: 0.3;
  }
  .anarchy-inventory-panel {
    position: absolute;
    top: 50%;
    left: 0;
    transform: translate(-100%, -50%);
    transition: transform 0.15s ease-out;
    width: ${PANEL_WIDTH_PX}px;
    background: ${PANEL_BACKGROUND};
    border: ${PANEL_BORDER};
    border-left: none;
    border-radius: 0 ${PANEL_BORDER_RADIUS_PX}px ${PANEL_BORDER_RADIUS_PX}px 0;
    box-shadow: 8px 0 24px rgba(0, 0, 0, 0.4);
    box-sizing: border-box;
    padding: ${PANEL_PAD_PX}px;
    display: grid;
    grid-template-columns: repeat(${PANEL_COLS}, ${SLOT_PX}px);
    gap: ${PANEL_GAP_PX}px;
  }
  .anarchy-inventory-panel.open { transform: translate(0, -50%); }
  .anarchy-inventory-slot {
    width: ${SLOT_PX}px;
    height: ${SLOT_PX}px;
    background: ${CELL_BACKGROUND};
    border: ${CELL_BORDER};
    border-radius: ${CELL_BORDER_RADIUS_PX}px;
    box-sizing: border-box;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* Cursor-on-cell affordance — placed before the modifier rules below
     so .selected / .equipped-* / .drag-reject continue to win on cells
     that already carry their own border-color. */
  .anarchy-inventory-slot:hover {
    border-color: ${CELL_HOVER_BORDER_COLOR};
  }
  .anarchy-inventory-slot.selected {
    border-color: #ffffff;
    box-shadow: 0 0 0 2px #5aa0ff inset;
  }
  /* Equipped-cell highlight (task 010 rework): the cell that holds the
     currently-equipped pickaxe paints orange; the axe cell paints green;
     the utility cell (task 360) paints blue. A cell can be both selected
     and equipped — the selected blue inner shadow still wins for the
     inner ring while the orange/green/blue background reads the
     equipment kind. */
  .anarchy-inventory-slot.equipped-pickaxe {
    background: rgba(220, 130, 30, 0.45);
    border-color: rgba(255, 165, 60, 0.85);
  }
  .anarchy-inventory-slot.equipped-axe {
    background: rgba(50, 160, 70, 0.45);
    border-color: rgba(90, 210, 110, 0.85);
  }
  .anarchy-inventory-slot.equipped-utility {
    background: rgba(40, 110, 220, 0.45);
    border-color: rgba(90, 160, 255, 0.85);
  }
  /* Task 530 fourth equipment kind. Yellow reads "earth-tool" / shovel
     against the orange/green/blue siblings without colliding. */
  .anarchy-inventory-slot.equipped-shovel {
    background: rgba(210, 180, 30, 0.45);
    border-color: rgba(245, 215, 80, 0.85);
  }
  .anarchy-inventory-slot.equipped-pickaxe.selected,
  .anarchy-inventory-slot.equipped-axe.selected,
  .anarchy-inventory-slot.equipped-utility.selected,
  .anarchy-inventory-slot.equipped-shovel.selected {
    border-color: #ffffff;
  }
  .anarchy-inventory-icon {
    width: 70%;
    height: 70%;
    border-radius: ${ICON_BORDER_RADIUS_PX}px;
    box-shadow: ${ICON_INSET_SHADOW};
  }
  .anarchy-inventory-count {
    position: absolute;
    bottom: 2px;
    right: 4px;
    font-size: ${COUNT_FONT_SIZE_PX}px;
    font-weight: ${COUNT_FONT_WEIGHT};
    text-shadow: ${COUNT_TEXT_SHADOW};
    pointer-events: none;
  }
  .anarchy-inventory-slot.drag-source { opacity: ${CELL_DRAG_SOURCE_OPACITY}; }
  /* BACKLOG 410: yellow border on the right-click "split source" cell.
     Sticky until the user left-clicks elsewhere. Wins over the white
     hover border thanks to specificity (class + class). */
  .anarchy-inventory-slot.split-source {
    border-color: ${CELL_SPLIT_SOURCE_BORDER_COLOR};
    box-shadow: ${CELL_SPLIT_SOURCE_INSET_SHADOW};
  }
  .anarchy-inventory-drag-preview {
    position: fixed;
    width: ${SLOT_PX}px;
    height: ${SLOT_PX}px;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 9000;
    background: rgba(20, 24, 30, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: ${CELL_BORDER_RADIUS_PX}px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

export function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}
