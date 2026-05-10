/**
 * CSS injection for the inventory overlay. The component owns its style
 * tag (one per page; identity check by `STYLE_ID`) so the rest of the
 * page stays untouched. The pixel constants are exported for the layout
 * machinery (panel width derives from `SLOT_PX`/`PANEL_GAP_PX`/etc.).
 */

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
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .anarchy-equipment-slot.empty .anarchy-inventory-icon {
    opacity: 0.3;
  }
  .anarchy-equipment-slot.drag-reject {
    border-color: rgba(255, 80, 80, 0.6);
  }
  .anarchy-inventory-panel {
    position: absolute;
    top: 50%;
    left: 0;
    transform: translate(-100%, -50%);
    transition: transform 0.15s ease-out;
    width: ${PANEL_WIDTH_PX}px;
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-left: none;
    border-radius: 0 8px 8px 0;
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
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
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
    border-color: rgba(255, 255, 255, 0.5);
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
  .anarchy-inventory-slot.equipped-pickaxe.selected,
  .anarchy-inventory-slot.equipped-axe.selected,
  .anarchy-inventory-slot.equipped-utility.selected {
    border-color: #ffffff;
  }
  .anarchy-inventory-icon {
    width: 70%;
    height: 70%;
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .anarchy-inventory-count {
    position: absolute;
    bottom: 2px;
    right: 4px;
    font-size: 12px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    pointer-events: none;
  }
  .anarchy-inventory-slot.drag-source { opacity: 0.4; }
  .anarchy-inventory-drag-preview {
    position: fixed;
    width: ${SLOT_PX}px;
    height: ${SLOT_PX}px;
    pointer-events: none;
    transform: translate(-50%, -50%);
    z-index: 9000;
    background: rgba(20, 24, 30, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: 4px;
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
