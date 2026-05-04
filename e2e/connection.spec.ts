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

type Frame = { kind: "open" } | { kind: "msg"; data: Uint8Array } | { kind: "close"; code: number };

async function openSocket(timeoutMs = 5_000): Promise<{
  ws: WebSocket;
  frames: Frame[];
  next: (predicate: (f: Frame) => boolean) => Promise<Frame>;
}> {
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

  function next(predicate: (f: Frame) => boolean): Promise<Frame> {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
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

test("websocket endpoint accepts a connection", async () => {
  const { ws } = await openSocket();
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
});

test("server sends a ServerWelcome with assigned player id and view radius after Hello", async () => {
  const { ws, next } = await openSocket();

  // The server defers Welcome until after admission — the lobby phase
  // gates the welcome on a valid ClientHello so the assigned `player_id`
  // can reflect either fresh allocation (this case) or a recycled
  // dormant id (reconnect path).
  const hello = ClientMessage.encode(
    ClientMessage.create({
      seq: 1,
      hello: {
        clientVersion: "anarchy-client/e2e",
        username: "welcome-test",
        colorIndex: 0,
      },
    }),
  ).finish();
  ws.send(hello);

  const frame = (await next((f) => f.kind === "msg")) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: {
      serverVersion?: string;
      playerId?: string | number;
      viewRadiusChunks?: number;
      tickRateHz?: number;
    };
  };
  expect(msg.welcome).toBeTruthy();
  expect(typeof msg.welcome!.serverVersion).toBe("string");
  expect(msg.welcome!.serverVersion!.length).toBeGreaterThan(0);

  const playerId = Number(msg.welcome!.playerId);
  expect(playerId).toBeGreaterThan(0);
  expect(Number(msg.welcome!.tickRateHz)).toBe(20);
  // Per ADR 0003 the welcome includes the per-client view-window radius
  // so the client can size buffers and validate the windows it receives.
  expect(Number(msg.welcome!.viewRadiusChunks)).toBeGreaterThan(0);

  ws.close();
});

test("Hello → Action → Ping: connection survives a multi-message handshake", async () => {
  const { ws, next, frames } = await openSocket();

  const hello = ClientMessage.encode(
    ClientMessage.create({
      seq: 1,
      hello: {
        clientVersion: "anarchy-client/e2e",
        username: "tester",
        colorIndex: 0,
      },
    }),
  ).finish();
  ws.send(hello);

  // Welcome is deferred until after admission completes — wait for it
  // before sending steady-state frames so this test pins the new
  // server ordering explicitly.
  await next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { welcome?: unknown };
    return m.welcome !== undefined;
  });

  const action = ClientMessage.encode(
    ClientMessage.create({
      seq: 2,
      action: { moveIntent: { dx: 0.0, dy: 1.0 }, clientSeq: 1 },
    }),
  ).finish();
  ws.send(action);

  const ping = ClientMessage.encode(
    ClientMessage.create({
      seq: 3,
      ping: { clientTimeMs: 999 },
    }),
  ).finish();
  ws.send(ping);

  const pongFrame = (await next((f) => {
    if (f.kind !== "msg") return false;
    const decoded = ServerMessage.decode(f.data).toJSON() as { pong?: unknown };
    return decoded.pong !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const pong = ServerMessage.decode(pongFrame.data).toJSON() as {
    ackSeq?: string | number;
    pong?: { clientTimeMs?: string | number };
  };
  expect(Number(pong.pong!.clientTimeMs)).toBe(999);
  expect(Number(pong.ackSeq)).toBe(3);

  expect(frames.some((f) => f.kind === "close")).toBe(false);

  ws.close();
});
