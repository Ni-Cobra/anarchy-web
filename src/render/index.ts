/**
 * Three.js view of the world. Reads the `World` mirror, owns the render
 * loop, follows the local player with a top-down camera. No knowledge of
 * the network or proto layer — a wire layer feeds `World` and tells the
 * renderer which player id is local.
 */
export { Renderer } from "./renderer.js";
export { syncPlayerMeshes, tileToScene, type PlayerMeshFactory } from "./sync.js";
