import { REACH_BLOCKS } from "./config.js";
import { CHUNK_SIZE, SnapshotBuffer, Terrain, World } from "./game/index.js";
import { InputController } from "./input/index.js";
import { applyServerMessage, connect } from "./net/index.js";
import { Renderer } from "./render/index.js";

// Test handle for browser-driven e2e (Playwright). Kept narrow on purpose:
// just the seams the spec needs to drive the app without poking internals.
declare global {
  interface Window {
    __anarchy?: {
      world: World;
      terrain: Terrain;
      getLocalPlayerId: () => number | null;
      sendMoveIntent: (dx: number, dy: number) => void;
      sendBreakBlock: (cx: number, cy: number, lx: number, ly: number) => void;
    };
  }
}

// Dev-only entrypoint flag: `?stub-terrain=1` skips the WebSocket connection
// and renders a hand-built `Terrain` so the terrain renderer can be exercised
// without a server. Production builds normally never pass this flag — see
// `dev/terrain_stub.ts`.
const params = new URLSearchParams(window.location.search);
if (params.get("stub-terrain") === "1") {
  void import("./dev/terrain_stub.js").then(({ runTerrainStub }) => {
    runTerrainStub();
  });
} else {
  runMain();
}

function runMain(): void {
  const world = new World();
  const buffer = new SnapshotBuffer();
  const terrain = new Terrain();
  const renderer = new Renderer(
    world,
    buffer,
    document.body,
    {
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
    },
    terrain,
  );
  window.addEventListener("resize", () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  });

  let localPlayerId: number | null = null;
  // Per-client monotonic action sequence. Mirrored into every outbound
  // `ClientAction.client_seq`. Per ADR 0003 prediction is removed; the
  // client no longer reconciles against the seq, but the server still
  // expects a monotonic counter and may surface it again later.
  let actionSeq = 0;

  const conn = connect("ws://localhost:8080/ws", (msg) => {
    applyServerMessage(msg, {
      world,
      buffer,
      terrain,
      terrainSink: {
        onChunkLoaded: (cx, cy) => renderer.applyChunkLoaded(cx, cy),
        onChunkUnloaded: (cx, cy) => renderer.applyChunkUnloaded(cx, cy),
      },
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
  }

  function sendBreakBlock(cx: number, cy: number, lx: number, ly: number): void {
    conn.send({ breakBlock: { chunkCoord: { cx, cy }, localX: lx, localY: ly } });
  }

  const input = new InputController({ sendMoveIntent });
  input.start(window);

  // Left-click to destroy the top-layer block under the cursor, gated by
  // the same reach the server enforces (REACH_BLOCKS, Euclidean from player
  // center to tile center). The server re-validates everything; this gate
  // just keeps obviously-out-of-reach clicks off the wire.
  window.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (localPlayerId === null) return;
    const ndc = {
      x: (ev.clientX / window.innerWidth) * 2 - 1,
      y: -(ev.clientY / window.innerHeight) * 2 + 1,
    };
    const pick = renderer.pickAtCursor(ndc);
    if (!pick || pick.layer !== "top") return;
    const me = world.getPlayer(localPlayerId);
    if (!me) return;
    const [cx, cy] = pick.chunkCoord;
    const [lx, ly] = pick.localXY;
    const tileCenterX = cx * CHUNK_SIZE + lx + 0.5;
    const tileCenterY = cy * CHUNK_SIZE + ly + 0.5;
    const dx = tileCenterX - me.x;
    const dy = tileCenterY - me.y;
    if (dx * dx + dy * dy > REACH_BLOCKS * REACH_BLOCKS) return;
    sendBreakBlock(cx, cy, lx, ly);
  });

  window.__anarchy = {
    world,
    terrain,
    getLocalPlayerId: () => localPlayerId,
    sendMoveIntent,
    sendBreakBlock,
  };
}
