/**
 * DOM overlays drawn over the game canvas. Each component is self-
 * contained (own CSS injection + DOM scaffolding) and exposes an `unmount`
 * affordance so `runMain`'s teardown can return the page to a clean state.
 */
export { mountSidePanel } from "./side_panel.js";
export type {
  SidePanelAction,
  SidePanelHandle,
  SidePanelOptions,
} from "./side_panel.js";
export { mountInventoryUi } from "./inventory/index.js";
export type {
  InventoryUiHandle,
  InventoryUiOptions,
} from "./inventory/index.js";
export { mountCraftingUi } from "./crafting/index.js";
export type {
  CraftingUiHandle,
  CraftingUiOptions,
} from "./crafting/index.js";
export { mountChestUi } from "./chest/index.js";
export type {
  ChestUiHandle,
  ChestUiOptions,
} from "./chest/index.js";
export { showRegisterModal, MIN_PASSWORD_LEN } from "./register_modal.js";
export type {
  RegisterModalHandle,
  RegisterModalOptions,
} from "./register_modal.js";
export { attachInputGate } from "./input_gate.js";
export type { InputGateHandle } from "./input_gate.js";
export { mountCoordsHud, formatCoords } from "./coords_hud.js";
export type { CoordsHudHandle } from "./coords_hud.js";
export {
  mountHpBar,
  hpFillColorFor,
  hpFillWidthPx,
  HP_THRESHOLD_HIGH,
  HP_THRESHOLD_LOW,
} from "./hp_bar.js";
export type { HpBarHandle } from "./hp_bar.js";
export { attachTooltip } from "./tooltip.js";
export type { TooltipContent, TooltipHandle } from "./tooltip.js";
