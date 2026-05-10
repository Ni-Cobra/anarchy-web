import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { adminSetTimeOfDay } from "./admin";

// Task 330 — wire-level e2e for the day-cycle-driven view radius. The
// per-client view window shrinks at night (radius 1, a 3×3 = 9-chunk
// neighborhood) from the daytime radius 2 (5×5 = 25). Two pins:
//   1. The first `TickUpdate` after admission carries the radius
//      that matches the world's current time-of-day (full day at
//      seconds=0; full night after we jump to midnight).
//   2. Once a client is mid-session, advancing time to midnight drops
//      the outermost ring from the per-tick payload (full + unmodified)
//      — chunks outside the night window vanish from the wire.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";
const DAY_LENGTH_SECONDS = 600;

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

let helloSeq = 9000;
async function sendHello(s: Socket, username: string): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex: 0, reconnect: false },
    }),
  ).finish();
  s.ws.send(bytes);
}

interface DecodedTick {
  fullChunks: Array<{ cx: number; cy: number }>;
  unmodified: Array<{ cx: number; cy: number }>;
}

interface DecodedWelcome {
  viewRadiusChunks: number;
}

function decode(data: Uint8Array): {
  welcome?: { viewRadiusChunks?: number };
  tickUpdate?: {
    fullStateChunks?: Array<{ coord?: { cx?: number; cy?: number } }>;
    unmodifiedChunks?: Array<{ cx?: number; cy?: number }>;
    timeOfDaySeconds?: number;
  };
} {
  return ServerMessage.decode(data).toJSON();
}

async function readWelcome(s: Socket): Promise<DecodedWelcome> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    return decode(f.data).welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const w = decode(frame.data).welcome!;
  return { viewRadiusChunks: Number(w.viewRadiusChunks ?? 0) };
}

async function readTick(s: Socket, timeout = 5_000): Promise<DecodedTick> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    return decode(f.data).tickUpdate !== undefined;
  }, timeout)) as Extract<Frame, { kind: "msg" }>;
  const t = decode(frame.data).tickUpdate!;
  return {
    fullChunks: (t.fullStateChunks ?? []).map((c) => ({
      cx: Number(c.coord?.cx ?? 0),
      cy: Number(c.coord?.cy ?? 0),
    })),
    unmodified: (t.unmodifiedChunks ?? []).map((c) => ({
      cx: Number(c.cx ?? 0),
      cy: Number(c.cy ?? 0),
    })),
  };
}

test.describe.configure({ mode: "serial" });

test("daytime welcome ships radius 2 and the first tick covers a 5×5 window", async () => {
  // Pin time-of-day to noon so the test isn't sensitive to whichever
  // wall-clock advance the shared server has accumulated since startup.
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.25);

  const s = await openSocket();
  await sendHello(s, "nrad-day");
  const welcome = await readWelcome(s);
  expect(welcome.viewRadiusChunks).toBe(2);

  const tick = await readTick(s);
  const total = tick.fullChunks.length + tick.unmodified.length;
  expect(total).toBe(25);

  s.ws.close();
});

test("midnight welcome ships radius 1 and the first tick covers a 3×3 window", async () => {
  // Pin time to midnight before opening the socket so admission's
  // `current_view_radius` reads the night value.
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.75);

  const s = await openSocket();
  await sendHello(s, "nrad-night");
  const welcome = await readWelcome(s);
  expect(welcome.viewRadiusChunks).toBe(1);

  const tick = await readTick(s);
  const total = tick.fullChunks.length + tick.unmodified.length;
  expect(total).toBe(9);
  // Every shipped chunk sits within Chebyshev distance 1 of the
  // player's chunk (admission lands fresh players in an origin-adjacent
  // chunk, so the window's outer bound is |c| ≤ 2 even after worst-
  // case spawn drift; the night radius itself is what we're pinning).
  for (const c of [...tick.fullChunks, ...tick.unmodified]) {
    expect(Math.abs(c.cx)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.cy)).toBeLessThanOrEqual(2);
  }

  s.ws.close();

  // Hand the world back to "day" so any spec running after this one
  // doesn't inherit a forced night.
  await adminSetTimeOfDay(0);
});

test("nightfall mid-session drops the outermost ring from the wire", async () => {
  test.setTimeout(15_000);

  // Start in daylight: client gets the full 5×5 window.
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.25);

  const s = await openSocket();
  await sendHello(s, "nrad-trans");
  const welcome = await readWelcome(s);
  expect(welcome.viewRadiusChunks).toBe(2);
  const dayTick = await readTick(s);
  const dayTotal = dayTick.fullChunks.length + dayTick.unmodified.length;
  expect(dayTotal).toBe(25);

  // Jump the server clock to midnight. The next tick after the world
  // mutex unlocks should ship the night window. Watch the
  // `timeOfDaySeconds` scalar to filter out any pre-jump frames the
  // socket has already buffered.
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.75);

  const nightFrame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    const msg = decode(f.data);
    if (!msg.tickUpdate) return false;
    const t = Number(msg.tickUpdate.timeOfDaySeconds ?? 0);
    return t >= DAY_LENGTH_SECONDS * 0.7;
  }, 5_000)) as Extract<Frame, { kind: "msg" }>;
  const post = decode(nightFrame.data).tickUpdate!;
  const total =
    (post.fullStateChunks ?? []).length + (post.unmodifiedChunks ?? []).length;
  expect(total).toBe(9);
  for (const c of post.fullStateChunks ?? []) {
    expect(Math.abs(Number(c.coord?.cx ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(c.coord?.cy ?? 0))).toBeLessThanOrEqual(2);
  }
  for (const c of post.unmodifiedChunks ?? []) {
    expect(Math.abs(Number(c.cx ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(c.cy ?? 0))).toBeLessThanOrEqual(2);
  }

  s.ws.close();
  await adminSetTimeOfDay(0);
});
