/**
 * Authoritative-state mirror, network-free.
 *
 * Nothing in this module — or any submodule — may know about WebSockets,
 * protobuf, or any wire format. A wire layer (in `net/`, when it lands)
 * translates incoming server messages into calls on `World`.
 */
export type { Player, PlayerId } from "./player.js";
export { World } from "./world.js";
