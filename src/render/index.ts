/**
 * Three.js view of the world. Reads the `World` mirror (for the local
 * player) and `SnapshotBuffer` (for interpolated remote players), owns the
 * render loop, follows the local player with a top-down camera. No
 * knowledge of the network or proto layer — a wire layer feeds both stores
 * and tells the renderer which player id is local.
 */
export { Renderer } from "./renderer.js";
export {
  composePlayerEntities,
  LOCAL_RENDER_DELAY_MS,
  REMOTE_RENDER_DELAY_MS,
} from "./compose.js";
export {
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
  type RenderableEntity,
} from "./sync.js";
