import { World } from "./game/index.js";
import { connect } from "./net.js";
import { Renderer } from "./render/index.js";

const world = new World();
const renderer = new Renderer(world);

// Placeholder seed: a local player at the origin and a couple of remote
// players around it, so the renderer has something to draw before the
// network task wires `World` to incoming `WorldSnapshot` frames. The
// upcoming snapshot-application task will replace this with `setLocalPlayerId`
// + `world.applySnapshot` calls driven by `ServerWelcome` / `StateUpdate`.
const LOCAL_ID = 1;
world.applySnapshot([
  { id: LOCAL_ID, x: 0, y: 0 },
  { id: 2, x: 3, y: 1 },
  { id: 3, x: -2, y: 4 },
]);
renderer.setLocalPlayerId(LOCAL_ID);

connect("ws://localhost:8080/ws", (msg) => {
  console.log("[recv]", msg.toJSON());
});
