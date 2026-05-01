/**
 * Three.js view of the world. Reads the `LocalPredictor` for the local
 * player and `SnapshotBuffer` for interpolated remote players, owns the
 * render loop, follows the local player with a top-down camera. No
 * knowledge of the network or proto layer — a wire layer feeds the stores
 * and tells the renderer which player id is local.
 */
export { Renderer } from "./renderer.js";
