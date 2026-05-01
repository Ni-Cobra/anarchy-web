/**
 * Keyboard-input layer. Translates browser keypresses into a continuous
 * `MoveIntent` for the server. Stays free of WebSocket / protobuf wiring —
 * the caller supplies an `InputSink` that knows how to dispatch.
 */
export { InputController } from "./controller.js";
