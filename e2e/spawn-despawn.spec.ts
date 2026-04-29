import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

type Frame = { kind: "open" } | { kind: "msg"; data: Uint8Array } | { kind: "close"; code: number };

interface Socket {
  ws: WebSocket;
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
  return { ws, next };
}

interface DecodedWelcome {
  playerId: number;
  playerIds: number[];
}

async function readWelcome(s: Socket): Promise<DecodedWelcome> {
  const frame = (await s.next((f) => f.kind === "msg")) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: {
      playerId?: string | number;
      snapshot?: { players?: { id?: string | number }[] };
    };
  };
  if (!msg.welcome) throw new Error("first frame was not a Welcome");
  const players = msg.welcome.snapshot?.players ?? [];
  return {
    playerId: Number(msg.welcome.playerId),
    playerIds: players.map((p) => Number(p.id)),
  };
}

test("a second client's Welcome snapshot includes the first client", async () => {
  const a = await openSocket();
  const wa = await readWelcome(a);
  expect(wa.playerId).toBeGreaterThan(0);
  expect(wa.playerIds).toContain(wa.playerId);

  const b = await openSocket();
  const wb = await readWelcome(b);
  expect(wb.playerId).toBeGreaterThan(0);
  expect(wb.playerId).not.toBe(wa.playerId);
  // B must see A in its initial snapshot — late joiners are correct from frame 0.
  expect(wb.playerIds).toContain(wa.playerId);
  expect(wb.playerIds).toContain(wb.playerId);

  a.ws.close();
  b.ws.close();
});

test("when one client disconnects, others receive a PlayerDespawned event", async () => {
  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  await readWelcome(b);

  // Close A and verify B sees the despawn event for A's id.
  a.ws.close();

  const event = (await b.next((f) => {
    if (f.kind !== "msg") return false;
    const decoded = ServerMessage.decode(f.data).toJSON() as {
      playerDespawned?: { playerId?: string | number };
    };
    return decoded.playerDespawned !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const decoded = ServerMessage.decode(event.data).toJSON() as {
    playerDespawned?: { playerId?: string | number };
  };
  expect(Number(decoded.playerDespawned!.playerId)).toBe(wa.playerId);

  b.ws.close();
});
