/**
 * Keyboard-input layer. Translates browser keypresses into `ClientAction`
 * intents for the server. Stays free of WebSocket / protobuf wiring — the
 * caller supplies an `InputSink` that knows how to dispatch.
 */
export { InputController, type InputSink } from "./controller.js";
export { keyToAction } from "./keymap.js";
