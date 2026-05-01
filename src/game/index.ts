/**
 * Authoritative-state mirror, network-free.
 *
 * Nothing in this module — or any submodule — may know about WebSockets,
 * protobuf, or any wire format. Translation from server messages into
 * mutations on `World` and `SnapshotBuffer` lives in `net/wire.ts`.
 */
export type { Player, PlayerId } from "./player.js";
export { World } from "./world.js";
export { SnapshotBuffer } from "./snapshot_buffer.js";
export {
  LocalPredictor,
  RECONCILE_SNAP_DISTANCE,
  SPEED,
} from "./predictor.js";
