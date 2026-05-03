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
