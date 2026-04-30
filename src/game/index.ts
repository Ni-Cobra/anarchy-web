/**
 * Authoritative-state mirror, network-free.
 *
 * Nothing in this module — or any submodule — may know about WebSockets,
 * protobuf, or any wire format. The `net/` wire layer translates incoming
 * server messages into calls on `World` and `SnapshotBuffer`.
 */
export type { Player, PlayerId } from "./player.js";
export { World } from "./world.js";
export { SnapshotBuffer, type Sample } from "./snapshot_buffer.js";
