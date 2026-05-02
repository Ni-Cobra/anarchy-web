/**
 * Three.js view of the world. Reads the `SnapshotBuffer` for every player's
 * interpolated position (per ADR 0003 prediction is removed; both local and
 * remote players flow through the same buffer-with-render-delay path), owns
 * the render loop, follows the local player with a top-down camera. No
 * knowledge of the network or proto layer — a wire layer feeds the stores
 * and tells the renderer which player id is local.
 */
export { Renderer } from "./renderer.js";
export type { PickLayer, PickResult } from "./picker.js";
