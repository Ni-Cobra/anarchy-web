import { anarchy } from "./gen/anarchy.js";
import { SnapshotBuffer, World } from "./game/index.js";
import { InputController } from "./input/index.js";
import { applyServerMessage, connect } from "./net/index.js";
import { Renderer } from "./render/index.js";

const world = new World();
const buffer = new SnapshotBuffer();
const renderer = new Renderer(world, buffer);

let localPlayerId: number | null = null;

const conn = connect("ws://localhost:8080/ws", (msg) => {
  applyServerMessage(msg, {
    world,
    buffer,
    local: {
      setLocalPlayerId: (id) => {
        localPlayerId = id;
        renderer.setLocalPlayerId(id);
      },
    },
  });
});

const input = new InputController({
  sendActions(actions) {
    conn.send({ action: { actions } });
  },
});
input.start(window);

// Test handle for browser-driven e2e (Playwright). Kept narrow on purpose:
// just the seams the spec needs to drive the app without poking internals.
declare global {
  interface Window {
    __anarchy?: {
      world: World;
      getLocalPlayerId: () => number | null;
      sendAction: (kind: anarchy.v1.ActionKind) => void;
    };
  }
}
window.__anarchy = {
  world,
  getLocalPlayerId: () => localPlayerId,
  sendAction: (kind) => conn.send({ action: { actions: [kind] } }),
};
