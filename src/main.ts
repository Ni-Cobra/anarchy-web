import { LocalPredictor, SnapshotBuffer, World } from "./game/index.js";
import { InputController } from "./input/index.js";
import { applyServerMessage, connect } from "./net/index.js";
import { Renderer } from "./render/index.js";

const world = new World();
const buffer = new SnapshotBuffer();
const predictor = new LocalPredictor();
const renderer = new Renderer(world, buffer, predictor);

let localPlayerId: number | null = null;
// Per-client monotonic action sequence. Mirrored into every outbound
// `ClientAction.client_seq` so the server's `PlayerSnapshot.acked_client_seq`
// echo can drive reconciliation.
let actionSeq = 0;

const conn = connect("ws://localhost:8080/ws", (msg) => {
  applyServerMessage(msg, {
    world,
    buffer,
    predictor,
    local: {
      setLocalPlayerId: (id) => {
        localPlayerId = id;
        renderer.setLocalPlayerId(id);
      },
      getLocalPlayerId: () => localPlayerId,
    },
  });
});

function sendMoveIntent(dx: number, dy: number): void {
  const seq = ++actionSeq;
  conn.send({ action: { moveIntent: { dx, dy }, clientSeq: seq } });
  predictor.setIntent(dx, dy, seq);
}

const input = new InputController({ sendMoveIntent });
input.start(window);

// Test handle for browser-driven e2e (Playwright). Kept narrow on purpose:
// just the seams the spec needs to drive the app without poking internals.
declare global {
  interface Window {
    __anarchy?: {
      world: World;
      predictor: LocalPredictor;
      getLocalPlayerId: () => number | null;
      sendMoveIntent: (dx: number, dy: number) => void;
    };
  }
}
window.__anarchy = {
  world,
  predictor,
  getLocalPlayerId: () => localPlayerId,
  sendMoveIntent,
};
