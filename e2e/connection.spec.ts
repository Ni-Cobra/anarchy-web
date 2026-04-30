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

test("server sends a ServerWelcome with assigned player id and self in snapshot", async () => {
  const { ws, next } = await openSocket();

  const frame = (await next((f) => f.kind === "msg")) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: {
      serverVersion?: string;
      playerId?: string | number;
      snapshot?: { players?: { id?: string | number; x?: number; y?: number }[] };
    };
  };
  expect(msg.welcome).toBeTruthy();
  expect(typeof msg.welcome!.serverVersion).toBe("string");
  expect(msg.welcome!.serverVersion!.length).toBeGreaterThan(0);

  const playerId = Number(msg.welcome!.playerId);
  expect(playerId).toBeGreaterThan(0);

  // Snapshot must contain the joining player so the client view is correct
  // from frame zero, with no need to wait for the next tick.
  const players = msg.welcome!.snapshot!.players ?? [];
  expect(players.some((p) => Number(p.id) === playerId)).toBe(true);

  ws.close();
});

test("Hello → Action → Ping: connection survives a multi-message handshake", async () => {
  const { ws, next, frames } = await openSocket();

  // Drain the unsolicited Welcome the server sends on connect.
  await next((f) => f.kind === "msg");

  const hello = ClientMessage.encode(
    ClientMessage.create({
      seq: 1,
      hello: { clientVersion: "anarchy-client/e2e" },
    }),
  ).finish();
  ws.send(hello);

  // ClientAction is fire-and-forget today; the network module + tick loop
  // will pick this up later. We just need the socket to keep eating bytes.
  const action = ClientMessage.encode(
    ClientMessage.create({
      seq: 2,
      action: { actions: [1 /* MOVE_NORTH */] },
    }),
  ).finish();
  ws.send(action);

  // Pong is the cheapest reply we can demand to prove the server is still
  // processing this connection's frames in order after the silent Hello/Action.
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

  // No close frames observed during the exchange.
  expect(frames.some((f) => f.kind === "close")).toBe(false);

  ws.close();
});
