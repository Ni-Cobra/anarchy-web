import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Per ADR 0003 the per-tick wire shape is `TickUpdate`, carrying the
// chunks in the receiver's view window — full state for new/changed,
// `unmodified_chunks` for known-unchanged, implicit unload otherwise.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

const SPEED = 5.0;
const TICK_DT = 0.05;

type Frame = { kind: "open" } | { kind: "msg"; data: Uint8Array } | { kind: "close"; code: number };

interface Socket {
  ws: WebSocket;
  frames: Frame[];
  next: (predicate: (f: Frame) => boolean, timeout?: number) => Promise<Frame>;
}

async function openSocket(timeoutMs = 5_000): Promise<Socket> {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  const frames: Frame[] = [];
  const waiters: Array<{ predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

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
    if (ev.data instanceof ArrayBuffer) push({ kind: "msg", data: new Uint8Array(ev.data) });
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
  return { ws, frames, next };
}

interface DecodedWelcome {
  playerId: number;
  tickRateHz: number;
  viewRadiusChunks: number;
}

async function readWelcome(
  s: Socket,
  username = "tester",
  colorIndex = 0,
): Promise<DecodedWelcome> {
  await sendHello(s, username, colorIndex);
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { welcome?: unknown };
    return m.welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: {
      playerId?: string | number;
      tickRateHz?: number;
      viewRadiusChunks?: number;
    };
  };
  if (!msg.welcome) throw new Error("first frame was not a Welcome");
  return {
    playerId: Number(msg.welcome.playerId),
    tickRateHz: Number(msg.welcome.tickRateHz ?? 0),
    viewRadiusChunks: Number(msg.welcome.viewRadiusChunks ?? 0),
  };
}

let helloSeq = 100;
async function sendHello(
  s: Socket,
  username = "tester",
  colorIndex = 0,
  reconnect = false,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex, reconnect },
    }),
  ).finish();
  s.ws.send(bytes);
}

function sendIntent(s: Socket, seq: number, dx: number, dy: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { moveIntent: { dx, dy }, clientSeq: seq } }),
  ).finish();
  s.ws.send(bytes);
}

interface PlayerInTick {
  id: number;
  x: number;
  y: number;
}

function readTickPlayers(frame: Extract<Frame, { kind: "msg" }>): PlayerInTick[] | null {
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    tickUpdate?: {
      fullStateChunks?: {
        players?: { id?: string | number; x?: number; y?: number }[];
      }[];
    };
  };
  if (!msg.tickUpdate) return null;
  const players: PlayerInTick[] = [];
  for (const c of msg.tickUpdate.fullStateChunks ?? []) {
    for (const p of c.players ?? []) {
      players.push({
        id: Number(p.id),
        x: Number(p.x ?? 0),
        y: Number(p.y ?? 0),
      });
    }
  }
  return players;
}

test("ServerWelcome reports the configured 20 Hz tick rate and view radius", async () => {
  const a = await openSocket();
  const wa = await readWelcome(a);
  expect(wa.tickRateHz).toBe(20);
  expect(wa.viewRadiusChunks).toBe(2);
  a.ws.close();
});

test("first TickUpdate after Welcome carries the full view window", async () => {
  // Per ADR 0003 a fresh client's `known_chunks` is empty, so the first
  // `TickUpdate` ships every chunk in the new player's view window as
  // full-state. At radius 2 that's a 5×5 = 25-chunk neighborhood.
  const a = await openSocket();
  await readWelcome(a);

  const frame = (await a.next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { tickUpdate?: unknown };
    return m.tickUpdate !== undefined;
  }, 5_000)) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    tickUpdate?: {
      fullStateChunks?: { coord?: { cx?: number; cy?: number } }[];
      unmodifiedChunks?: { cx?: number; cy?: number }[];
    };
  };
  const fullCoords = (msg.tickUpdate!.fullStateChunks ?? []).map((c) => [
    Number(c.coord?.cx ?? 0),
    Number(c.coord?.cy ?? 0),
  ]);
  const unmodified = msg.tickUpdate!.unmodifiedChunks ?? [];
  // First tick after Welcome → known set was empty → everything in window
  // should be full-state, nothing unmodified.
  expect(fullCoords.length).toBe(25);
  expect(unmodified.length).toBe(0);

  a.ws.close();
});

test("a held intent advances the player continuously across ticks", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  const inv_sqrt2 = 1 / Math.sqrt(2);
  sendIntent(a, 1, inv_sqrt2, inv_sqrt2);

  const minDist = SPEED * TICK_DT * 2 * inv_sqrt2;
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readTickPlayers(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const self = players.find((p) => p.id === me);
    return self !== undefined && self.x > minDist && self.y > minDist;
  }, 5_000);

  a.ws.close();
});

test("two clients see each other move via TickUpdate broadcasts", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  await readWelcome(b);

  sendIntent(a, 1, 1.0, 0.0);

  // B should see a TickUpdate carrying A at x > 0 inside one of the
  // full-state chunks (A's chunk is dirty as A moves, and B's view window
  // overlaps it since both spawned at origin).
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readTickPlayers(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const peer = players.find((p) => p.id === wa.playerId);
    return peer !== undefined && peer.x > 0;
  }, 5_000);

  a.ws.close();
  b.ws.close();
});

test("an idle player produces no full-state chunks (stable ticks list everything as unmodified)", async () => {
  // Per ADR 0003 §2 a chunk is dirty only on actual mutation. After the
  // spawn-induced first tick, an idle player's chunk goes back to clean,
  // so subsequent ticks should ship full=0 / unmodified=25.
  test.setTimeout(10_000);

  const a = await openSocket();
  await readWelcome(a);

  // Wait long enough for several ticks (50 ms each) plus the joining
  // burst — 500 ms gives us ~10 ticks.
  await new Promise((r) => setTimeout(r, 500));

  // Snapshot the current frame buffer and walk every TickUpdate; expect
  // at least one to be the steady-state "everything unmodified" shape.
  let sawIdleTick = false;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const msg = ServerMessage.decode(f.data).toJSON() as {
      tickUpdate?: {
        fullStateChunks?: unknown[];
        unmodifiedChunks?: unknown[];
      };
    };
    if (!msg.tickUpdate) continue;
    const fullN = (msg.tickUpdate.fullStateChunks ?? []).length;
    const unmodN = (msg.tickUpdate.unmodifiedChunks ?? []).length;
    if (fullN === 0 && unmodN === 25) {
      sawIdleTick = true;
      break;
    }
  }
  expect(sawIdleTick).toBe(true);

  a.ws.close();
});
