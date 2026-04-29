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

test("server sends a Welcome on connect", async () => {
  const { ws, next } = await openSocket();

  const frame = (await next((f) => f.kind === "msg")) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: { serverVersion?: string };
  };
  expect(msg.welcome).toBeTruthy();
  expect(typeof msg.welcome!.serverVersion).toBe("string");
  expect(msg.welcome!.serverVersion!.length).toBeGreaterThan(0);

  ws.close();
});

test("Hello → server roundtrip: connection survives the client handshake", async () => {
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

  // Server logs Hello but doesn't reply — verify the socket stays open under load
  // by sending a follow-up Input and confirming we get an InputEcho back.
  const input = ClientMessage.encode(
    ClientMessage.create({
      seq: 2,
      input: { buttons: 0b0101, clientTimeMs: 123 },
    }),
  ).finish();
  ws.send(input);

  const echoFrame = (await next((f) => {
    if (f.kind !== "msg") return false;
    const decoded = ServerMessage.decode(f.data).toJSON() as { inputEcho?: unknown };
    return decoded.inputEcho !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const echo = ServerMessage.decode(echoFrame.data).toJSON() as {
    ackSeq?: string | number;
    inputEcho?: { buttons?: number };
  };
  expect(echo.inputEcho!.buttons).toBe(0b0101);
  // ackSeq is uint64; protobufjs renders it as a string in toJSON.
  expect(Number(echo.ackSeq)).toBe(2);

  // No close frames observed during the exchange.
  expect(frames.some((f) => f.kind === "close")).toBe(false);

  ws.close();
});
