/**
 * Networking layer: WebSocket transport (`connection.ts`) and the bridge
 * (`wire.ts`) that translates decoded `ServerMessage` payloads into calls
 * on the network-free `World` + `SnapshotBuffer`.
 *
 * Nothing outside this directory should import from `../gen/anarchy.js` —
 * it's the boundary where protobuf types stay confined.
 */
export { connect } from "./connection.js";
export type {
  LobbyIdentity,
  LobbyRejectReason,
  ConnectHooks,
} from "./connection.js";
export { applyServerMessage, blockTypeToWire } from "./wire.js";
