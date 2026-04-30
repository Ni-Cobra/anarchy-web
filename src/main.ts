import { SnapshotBuffer, World } from "./game/index.js";
import { InputController } from "./input/index.js";
import { applyServerMessage, connect } from "./net/index.js";
import { Renderer } from "./render/index.js";

const world = new World();
const buffer = new SnapshotBuffer();
const renderer = new Renderer(world, buffer);

const conn = connect("ws://localhost:8080/ws", (msg) => {
  applyServerMessage(msg, {
    world,
    buffer,
    local: { setLocalPlayerId: (id) => renderer.setLocalPlayerId(id) },
  });
});

const input = new InputController({
  sendAction(action) {
    conn.send({ action: { action } });
  },
});
input.start(window);
