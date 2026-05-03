import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
}

async function readWelcome(s: Socket): Promise<DecodedWelcome> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { welcome?: unknown };
    return m.welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: { playerId?: string | number };
  };
  if (!msg.welcome) throw new Error("first frame was not a Welcome");
  await sendHello(s);
  return { playerId: Number(msg.welcome.playerId) };
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

test("malformed binary frames are dropped without killing the connection", async () => {
  const a = await openSocket();
  await readWelcome(a);

  a.ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

  const ping = ClientMessage.encode(
    ClientMessage.create({ seq: 99, ping: { clientTimeMs: 42 } }),
  ).finish();
  a.ws.send(ping);

  const pongFrame = (await a.next((f) => {
    if (f.kind !== "msg") return false;
    const decoded = ServerMessage.decode(f.data).toJSON() as { pong?: unknown };
    return decoded.pong !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const pong = ServerMessage.decode(pongFrame.data).toJSON() as {
    pong?: { clientTimeMs?: string | number };
  };
  expect(Number(pong.pong!.clientTimeMs)).toBe(42);

  a.ws.close();
});

test("an oversized intent magnitude is clamped to unit speed", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq: 1, action: { moveIntent: { dx: 100.0, dy: 0.0 }, clientSeq: 1 } }),
  ).finish();
  a.ws.send(bytes);

  const WAIT_MS = 500;
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // Find the latest TickUpdate mentioning me.
  let latestX: number | null = null;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const players = readTickPlayers(f);
    if (!players) continue;
    const self = players.find((p) => p.id === me);
    if (self) latestX = self.x;
  }

  expect(latestX).not.toBeNull();
  const maxExpected = SPEED * (WAIT_MS / 1000) * 1.5;
  expect(latestX!).toBeGreaterThan(0);
  expect(latestX!).toBeLessThan(maxExpected);

  a.ws.close();
});

test("a flood of intent updates is rate-limited so the player cannot teleport", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  for (let i = 1; i <= 200; i++) {
    const bytes = ClientMessage.encode(
      ClientMessage.create({ seq: i, action: { moveIntent: { dx: 5.0, dy: 0.0 }, clientSeq: i } }),
    ).finish();
    a.ws.send(bytes);
  }

  const WAIT_MS = 1500;
  await new Promise((r) => setTimeout(r, WAIT_MS));

  let latestX: number | null = null;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const players = readTickPlayers(f);
    if (!players) continue;
    const self = players.find((p) => p.id === me);
    if (self) latestX = self.x;
  }

  expect(latestX).not.toBeNull();
  expect(latestX!).toBeGreaterThan(0);
  const maxExpected = SPEED * (WAIT_MS / 1000) * 1.5;
  expect(latestX!).toBeLessThan(maxExpected);

  a.ws.close();
});

test("an oversized binary frame is rejected and the connection is dropped", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  await readWelcome(a);

  const huge = new Uint8Array(256 * 1024);
  a.ws.send(huge);

  const closed = await a.next((f) => f.kind === "close");
  expect(closed.kind).toBe("close");
});

test("a flood of inbound frames (ping-spam) is rate-limited and the server keeps serving", async () => {
  test.setTimeout(15_000);

  const a = await openSocket();
  await readWelcome(a);

  const N = 500;
  for (let i = 1; i <= N; i++) {
    const bytes = ClientMessage.encode(
      ClientMessage.create({ seq: i, ping: { clientTimeMs: i } }),
    ).finish();
    a.ws.send(bytes);
  }

  await new Promise((r) => setTimeout(r, 1500));

  let pongCount = 0;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const decoded = ServerMessage.decode(f.data).toJSON() as { pong?: unknown };
    if (decoded.pong !== undefined) pongCount++;
  }
  expect(pongCount).toBeGreaterThan(0);
  expect(pongCount).toBeLessThan(N);

  const b = await openSocket();
  await readWelcome(b);

  a.ws.close();
  b.ws.close();
});

void TICK_DT;
