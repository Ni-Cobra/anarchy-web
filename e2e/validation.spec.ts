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
  const frame = (await s.next((f) => f.kind === "msg")) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: { playerId?: string | number };
  };
  if (!msg.welcome) throw new Error("first frame was not a Welcome");
  return { playerId: Number(msg.welcome.playerId) };
}

interface PlayerInSnapshot {
  id: number;
  x: number;
  y: number;
}

function readStateUpdate(frame: Extract<Frame, { kind: "msg" }>): PlayerInSnapshot[] | null {
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    stateUpdate?: { snapshot?: { players?: { id?: string | number; x?: number; y?: number }[] } };
  };
  if (!msg.stateUpdate) return null;
  return (msg.stateUpdate.snapshot?.players ?? []).map((p) => ({
    id: Number(p.id),
    x: Number(p.x ?? 0),
    y: Number(p.y ?? 0),
  }));
}

test("malformed binary frames are dropped without killing the connection", async () => {
  const a = await openSocket();
  await readWelcome(a);

  // Send pure garbage that will fail protobuf decode.
  a.ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

  // Then a valid Ping — we must still receive a Pong, proving the connection
  // and decode loop survived the malformed input.
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
  // Hostile client sends |intent| = 100 east. Server must clamp to 1, so
  // the player advances at SPEED tiles/sec, not 100*SPEED. Sample after
  // ~500ms and assert the position is bounded by SPEED * elapsed * a
  // small slack factor.
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq: 1, action: { moveIntent: { dx: 100.0, dy: 0.0 } } }),
  ).finish();
  a.ws.send(bytes);

  const WAIT_MS = 500;
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // Find the latest snapshot mentioning me.
  let latestX: number | null = null;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const players = readStateUpdate(f);
    if (!players) continue;
    const self = players.find((p) => p.id === me);
    if (self) latestX = self.x;
  }

  expect(latestX).not.toBeNull();
  // Clamp must hold: travelled distance ≤ SPEED * elapsed (with some
  // generous slack for tick alignment / scheduling jitter).
  const maxExpected = SPEED * (WAIT_MS / 1000) * 1.5; // 50% slack
  expect(latestX!).toBeGreaterThan(0); // motion happened
  expect(latestX!).toBeLessThan(maxExpected);

  a.ws.close();
});

test("a flood of intent updates is rate-limited so the player cannot teleport", async () => {
  // The 30/s sustained limit caps how many intent updates are accepted. A
  // hostile client that fires 200 alternating-direction intents back-to-
  // back should still see its player travel at most SPEED * elapsed (since
  // each accepted intent is itself clamped to magnitude 1 and the server
  // applies them sequentially as state-replacing). The limit prevents
  // backlog DoS, not teleporting (which is already ruled out by clamping).
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  // Fire-hose 200 east intents — each above unit magnitude on purpose to
  // also exercise the clamp.
  for (let i = 1; i <= 200; i++) {
    const bytes = ClientMessage.encode(
      ClientMessage.create({ seq: i, action: { moveIntent: { dx: 5.0, dy: 0.0 } } }),
    ).finish();
    a.ws.send(bytes);
  }

  // Wait long enough for several ticks plus measurable refill.
  const WAIT_MS = 1500;
  await new Promise((r) => setTimeout(r, WAIT_MS));

  let latestX: number | null = null;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const players = readStateUpdate(f);
    if (!players) continue;
    const self = players.find((p) => p.id === me);
    if (self) latestX = self.x;
  }

  expect(latestX).not.toBeNull();
  expect(latestX!).toBeGreaterThan(0);
  // Hard cap from the clamp: position ≤ SPEED * elapsed (generous slack).
  const maxExpected = SPEED * (WAIT_MS / 1000) * 1.5;
  expect(latestX!).toBeLessThan(maxExpected);

  a.ws.close();
});

test("an oversized binary frame is rejected and the connection is dropped", async () => {
  // Server caps inbound message size at 64 KiB (see
  // anarchy-server/src/network/conn.rs::MAX_INBOUND_MESSAGE_SIZE). A
  // legitimate ClientMessage is well under 256 bytes — anything an order
  // of magnitude larger is a misbehaving or hostile client. Send 256 KiB
  // and expect the WebSocket to close, proving the server did not just
  // allocate the full payload silently.
  test.setTimeout(10_000);

  const a = await openSocket();
  await readWelcome(a);

  const huge = new Uint8Array(256 * 1024); // 256 KiB > the 64 KiB cap.
  a.ws.send(huge);

  // The server should tear the connection down. Either a Close frame or
  // an underlying socket close (close-event) is acceptable — what we care
  // about is that we don't sit in a half-open state forever, and that no
  // crash takes the whole server down (the next test confirms the second
  // half by reconnecting).
  const closed = await a.next((f) => f.kind === "close");
  expect(closed.kind).toBe("close");
});

test("a flood of inbound frames (ping-spam) is rate-limited and the server keeps serving", async () => {
  // The inbound rate limit applies to every binary frame, not just
  // actions, so a Ping flood cannot force the server to allocate
  // unbounded Pong replies. After firing many pings rapidly, we must
  // still receive *some* Pongs (the burst budget) but well fewer than
  // sent. The server must remain healthy throughout — fresh connection
  // opens and gets a Welcome.
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

  // Settle. The recv-side limiter is 60/s sustained, 120 burst — at most
  // ~120 Pongs in the first instant, with more over time as the bucket
  // refills. Wait long enough for the server to have processed (or
  // dropped) every queued frame.
  await new Promise((r) => setTimeout(r, 1500));

  let pongCount = 0;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const decoded = ServerMessage.decode(f.data).toJSON() as { pong?: unknown };
    if (decoded.pong !== undefined) pongCount++;
  }
  // Hard limit on accepted frames over ~1.5s = burst (120) + 60/s * 1.5s
  // ≈ 210 — far less than N=500. Assert we got at least one Pong (the
  // burst served some) and strictly fewer than N (the rest were dropped).
  expect(pongCount).toBeGreaterThan(0);
  expect(pongCount).toBeLessThan(N);

  // Server is still healthy: a brand-new connection opens and gets a
  // Welcome.
  const b = await openSocket();
  await readWelcome(b);

  a.ws.close();
  b.ws.close();
});

// Touch TICK_DT so it shows up in linter scans even if no test consumes it
// directly. Keeps the constant grouped with SPEED above for clarity.
void TICK_DT;
