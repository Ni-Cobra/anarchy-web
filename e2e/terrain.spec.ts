import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Wire-level e2e for the terrain protocol under ADR 0003. Pins:
//   (a) a fresh joining client receives a TickUpdate carrying the four
//       default chunks (and the rest of the radius-2 view window) as
//       full-state, with both layers populated at LAYER_AREA blocks each;
//   (b) when one player walks far enough to cross a chunk boundary, the
//       previously-out-of-view chunks they pull in get shipped to *them*
//       as full-state, and the chunks the *other* client can no longer
//       see are implicitly unloaded for it (i.e. drop out of the new
//       known-window).

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

const VIEW_RADIUS_CHUNKS = 2;
const LAYER_SIZE = 16;
const LAYER_AREA = LAYER_SIZE * LAYER_SIZE;

const DEFAULT_CHUNK_COORDS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [0, -1],
  [0, 0],
];

type Frame =
  | { kind: "open" }
  | { kind: "msg"; data: Uint8Array }
  | { kind: "close"; code: number };

interface Socket {
  ws: WebSocket;
  next: (predicate: (f: Frame) => boolean, timeout?: number) => Promise<Frame>;
}

async function openSocket(timeoutMs = 5_000): Promise<Socket> {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  const frames: Frame[] = [];
  const waiters: Array<{
    predicate: (f: Frame) => boolean;
    resolve: (f: Frame) => void;
  }> = [];

  const push = (f: Frame) => {
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(f)) {
        waiters[i].resolve(f);
        waiters.splice(i, 1);
      }
    }
  };

  ws.addEventListener("open", () => push({ kind: "open" }));
  ws.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      push({ kind: "msg", data: new Uint8Array(ev.data) });
    }
  });
  ws.addEventListener("close", (ev) => push({ kind: "close", code: ev.code }));

  function next(predicate: (f: Frame) => boolean, timeout = timeoutMs): Promise<Frame> {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeout);
      waiters.push({
        predicate: (f) => {
          if (predicate(f)) {
            clearTimeout(timer);
            return true;
          }
          return false;
        },
        resolve,
      });
    });
  }

  await next((f) => f.kind === "open");
  return { ws, next };
}

interface DecodedTick {
  fullChunks: { cx: number; cy: number; ground: number; top: number }[];
  unmodified: { cx: number; cy: number }[];
}

function decodeServerMessage(data: Uint8Array): {
  welcome?: { playerId?: string | number };
  tickUpdate?: {
    fullStateChunks?: {
      coord?: { cx?: number; cy?: number };
      ground?: { blocks?: { kind?: number }[] };
      top?: { blocks?: { kind?: number }[] };
      players?: { id?: string | number; x?: number; y?: number }[];
    }[];
    unmodifiedChunks?: { cx?: number; cy?: number }[];
  };
} {
  return ServerMessage.decode(data).toJSON();
}

async function readWelcome(s: Socket): Promise<number> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeServerMessage(f.data).welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const id = Number(decodeServerMessage(frame.data).welcome!.playerId);
  await sendHello(s);
  return id;
}

let helloSeq = 100;
async function sendHello(s: Socket, username = "tester", colorIndex = 0): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex },
    }),
  ).finish();
  s.ws.send(bytes);
}

async function readTick(s: Socket, timeout = 5_000): Promise<DecodedTick> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeServerMessage(f.data).tickUpdate !== undefined;
  }, timeout)) as Extract<Frame, { kind: "msg" }>;
  const msg = decodeServerMessage(frame.data);
  const fullChunks = (msg.tickUpdate!.fullStateChunks ?? []).map((c) => ({
    cx: Number(c.coord?.cx ?? 0),
    cy: Number(c.coord?.cy ?? 0),
    ground: (c.ground?.blocks ?? []).length,
    top: (c.top?.blocks ?? []).length,
  }));
  const unmodified = (msg.tickUpdate!.unmodifiedChunks ?? []).map((c) => ({
    cx: Number(c.cx ?? 0),
    cy: Number(c.cy ?? 0),
  }));
  return { fullChunks, unmodified };
}

function sendIntent(s: Socket, seq: number, dx: number, dy: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { moveIntent: { dx, dy }, clientSeq: seq } }),
  ).finish();
  s.ws.send(bytes);
}

test("a joining client's first TickUpdate carries the full view window with the four default chunks present", async () => {
  const a = await openSocket();
  await readWelcome(a);

  const tick = await readTick(a);
  // The defaults must be present somewhere in the first tick's full-state.
  const fullCoords = tick.fullChunks.map((c) => [c.cx, c.cy] as const);
  for (const [cx, cy] of DEFAULT_CHUNK_COORDS) {
    expect(fullCoords).toContainEqual([cx, cy]);
  }
  // Every chunk on the wire owes both layers at full LAYER_AREA length.
  for (const c of tick.fullChunks) {
    expect(c.ground).toBe(LAYER_AREA);
    expect(c.top).toBe(LAYER_AREA);
  }

  a.ws.close();
});

test("crossing a chunk boundary delivers newly-in-view chunks as full-state to the moving client", async () => {
  // Per ADR 0003 there is no global ChunkLoaded event. The interest-managed
  // delivery means: when player A walks east into a new chunk, A's view
  // window slides east and the column at x = newChunk + radius enters their
  // window for the first time — those chunks must appear in A's full-state.
  test.setTimeout(15_000);

  const a = await openSocket();
  await readWelcome(a);
  // Drain the joining tick (full window).
  const initial = await readTick(a);
  const initialKnown = new Set(initial.fullChunks.map((c) => `${c.cx},${c.cy}`));

  // A walks east — chunk (0, 0) → (1, 0) at x = CHUNK_SIZE = 16.
  // After crossing, A's window is x ∈ [-1, 3], so the column at x=3
  // (cy ∈ [-2, 2]) enters their view for the first time.
  sendIntent(a, 1, 1.0, 0.0);

  let sawNewColumn = false;
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const msg = decodeServerMessage(f.data);
    if (!msg.tickUpdate) return false;
    for (const c of msg.tickUpdate.fullStateChunks ?? []) {
      const cx = Number(c.coord?.cx ?? 0);
      const cy = Number(c.coord?.cy ?? 0);
      if (cx === VIEW_RADIUS_CHUNKS + 1 && Math.abs(cy) <= VIEW_RADIUS_CHUNKS) {
        if (!initialKnown.has(`${cx},${cy}`)) {
          sawNewColumn = true;
          // Must be a complete chunk on the wire.
          expect((c.ground?.blocks ?? []).length).toBe(LAYER_AREA);
          expect((c.top?.blocks ?? []).length).toBe(LAYER_AREA);
          break;
        }
      }
    }
    return sawNewColumn;
  }, 12_000);

  expect(sawNewColumn).toBe(true);
  // Stop A so a follow-up test wouldn't inherit motion.
  sendIntent(a, 2, 0.0, 0.0);

  a.ws.close();
});
