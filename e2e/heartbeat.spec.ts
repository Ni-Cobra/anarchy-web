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
  next: (predicate: (f: Frame) => boolean, timeout?: number) => Promise<Frame>;
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

test("Ping → Pong roundtrip echoes client_time_ms", async () => {
  const { ws, next } = await openSocket();

  // Drain the unsolicited Welcome.
  await next((f) => f.kind === "msg");

  const clientTimeMs = 1234567;
  const ping = ClientMessage.encode(
    ClientMessage.create({ seq: 1, ping: { clientTimeMs } }),
  ).finish();
  ws.send(ping);

  const pongFrame = (await next((f) => {
    if (f.kind !== "msg") return false;
    const decoded = ServerMessage.decode(f.data).toJSON() as { pong?: unknown };
    return decoded.pong !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;

  const pong = ServerMessage.decode(pongFrame.data).toJSON() as {
    ackSeq?: string | number;
    pong?: { clientTimeMs?: string | number; serverTimeMs?: string | number };
  };
  expect(Number(pong.pong!.clientTimeMs)).toBe(clientTimeMs);
  expect(Number(pong.pong!.serverTimeMs)).toBeGreaterThan(0);
  expect(Number(pong.ackSeq)).toBe(1);

  ws.close();
});

test("server disconnects an idle client after the recv timeout", async () => {
  // Server idle timeout is 15s; allow some slack for scheduling.
  test.setTimeout(25_000);

  const { ws, next } = await openSocket();
  // Drain the Welcome but then send nothing, ever.
  await next((f) => f.kind === "msg");

  const closeFrame = (await next((f) => f.kind === "close", 22_000)) as Extract<
    Frame,
    { kind: "close" }
  >;
  expect(closeFrame.kind).toBe("close");
  expect(ws.readyState).toBe(WebSocket.CLOSED);
});
