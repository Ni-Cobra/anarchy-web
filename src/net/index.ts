/**
 * Networking layer: WebSocket transport (`connection.ts`) and the bridge
 * (`wire.ts`) that translates decoded `ServerMessage` payloads into calls
 * on the network-free `World` + `SnapshotBuffer`.
 *
 * Nothing outside this directory should import from `../gen/anarchy.js` —
 * it's the boundary where protobuf types stay confined.
 */
export { connect, type Connection, type ServerHandler } from "./connection.js";
export { applyServerMessage, type LocalPlayerSink, type WireDeps } from "./wire.js";
