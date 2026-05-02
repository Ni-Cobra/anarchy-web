import { REACH_BLOCKS } from "./config.js";
import { BlockType, CHUNK_SIZE, SnapshotBuffer, Terrain, World } from "./game/index.js";
import { InputController } from "./input/index.js";
import { applyServerMessage, blockTypeToWire, connect } from "./net/index.js";
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
      sendPlaceBlock: (
        cx: number,
        cy: number,
        lx: number,
        ly: number,
        kind: BlockType,
      ) => void;
      isBuilderMode: () => boolean;
      setBuilderMode: (on: boolean) => void;
      // Same gate the builder-mode ghost preview uses (reach + AABB
      // overlap + top-Air). Exposed for e2e specs that need to assert
      // ghost-visibility behavior without driving the camera/cursor.
      canPlaceAt: (cx: number, cy: number, lx: number, ly: number) => boolean;
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

  function sendPlaceBlock(
    cx: number,
    cy: number,
    lx: number,
    ly: number,
    kind: BlockType,
  ): void {
    conn.send({
      placeBlock: {
        chunkCoord: { cx, cy },
        localX: lx,
        localY: ly,
        kind: blockTypeToWire(kind),
      },
    });
  }

  const input = new InputController({ sendMoveIntent });
  input.start(window);

  // Builder mode (toggled with `E`): while on, the cell under the cursor is
  // previewed as a translucent gold ghost — but only when (a) within reach,
  // (b) top-layer empty, (c) no player AABB overlaps the cell. Right-click
  // sends a `PlaceBlock` for that cell. Outside builder mode right-click
  // does nothing; left-click always destroys (the two flows live on
  // separate buttons so they never conflict).
  let builderMode = false;
  let cursorNdc: { x: number; y: number } | null = null;

  // Mirrors `World::try_place_top_block`'s validation in the client UI: top
  // cell empty, target in reach, no player AABB overlapping the cell. The
  // ghost preview and the right-click handler both gate on this so the UI
  // never invites a click the server will silently drop. Strict-overlap
  // (axis distance < 1.0) matches the server's check, including the
  // "flush against the cell" exception.
  function canPlaceAt(
    cx: number,
    cy: number,
    lx: number,
    ly: number,
  ): boolean {
    if (localPlayerId === null) return false;
    const me = world.getPlayer(localPlayerId);
    if (!me) return false;
    const chunk = terrain.get(cx, cy);
    if (!chunk) return false;
    const top = chunk.top.blocks[ly * CHUNK_SIZE + lx];
    if (!top || top.kind !== BlockType.Air) return false;
    const tileCenterX = cx * CHUNK_SIZE + lx + 0.5;
    const tileCenterY = cy * CHUNK_SIZE + ly + 0.5;
    const dx = tileCenterX - me.x;
    const dy = tileCenterY - me.y;
    if (dx * dx + dy * dy > REACH_BLOCKS * REACH_BLOCKS) return false;
    for (const p of world.players()) {
      if (
        Math.abs(p.x - tileCenterX) < 1.0 &&
        Math.abs(p.y - tileCenterY) < 1.0
      ) {
        return false;
      }
    }
    return true;
  }

  function pickGhostCell(): readonly [number, number, number, number] | null {
    if (!builderMode || cursorNdc === null) return null;
    const pick = renderer.pickAtCursor(cursorNdc);
    if (!pick) return null;
    if (pick.layer !== "ground") return null;
    const [cx, cy] = pick.chunkCoord;
    const [lx, ly] = pick.localXY;
    return canPlaceAt(cx, cy, lx, ly) ? [cx, cy, lx, ly] : null;
  }

  function refreshGhost(): void {
    renderer.setGhostCell(pickGhostCell());
  }

  // Refresh the ghost every animation frame so a remote player walking onto
  // the targeted cell hides the preview without waiting for a mousemove.
  // Cheap: a single raycast + a few players per frame.
  function ghostTick(): void {
    refreshGhost();
    requestAnimationFrame(ghostTick);
  }
  requestAnimationFrame(ghostTick);

  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "KeyE") return;
    if (ev.repeat) return;
    builderMode = !builderMode;
    refreshGhost();
  });

  window.addEventListener("mousemove", (ev) => {
    cursorNdc = {
      x: (ev.clientX / window.innerWidth) * 2 - 1,
      y: -(ev.clientY / window.innerHeight) * 2 + 1,
    };
  });

  // Suppress the browser context menu so right-click is available for placement.
  window.addEventListener("contextmenu", (ev) => ev.preventDefault());

  window.addEventListener("mousedown", (ev) => {
    if (localPlayerId === null) return;
    const ndc = {
      x: (ev.clientX / window.innerWidth) * 2 - 1,
      y: -(ev.clientY / window.innerHeight) * 2 + 1,
    };
    if (ev.button === 0) {
      // Left-click → destroy the top-layer block under the cursor.
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
      return;
    }
    if (ev.button === 2 && builderMode) {
      // Right-click in builder mode → place gold at the ghost cell.
      cursorNdc = ndc;
      const cell = pickGhostCell();
      if (!cell) return;
      const [cx, cy, lx, ly] = cell;
      sendPlaceBlock(cx, cy, lx, ly, BlockType.Gold);
    }
  });

  window.__anarchy = {
    world,
    terrain,
    getLocalPlayerId: () => localPlayerId,
    sendMoveIntent,
    sendBreakBlock,
    sendPlaceBlock,
    isBuilderMode: () => builderMode,
    setBuilderMode: (on) => {
      builderMode = on;
      refreshGhost();
    },
    canPlaceAt,
  };
}
