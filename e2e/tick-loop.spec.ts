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

const ACTION_MOVE_NORTH = 1;
const ACTION_MOVE_EAST = 3;

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
  tickRateHz: number;
}

async function readWelcome(s: Socket): Promise<DecodedWelcome> {
  const frame = (await s.next((f) => f.kind === "msg")) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: { playerId?: string | number; tickRateHz?: number };
  };
  if (!msg.welcome) throw new Error("first frame was not a Welcome");
  return {
    playerId: Number(msg.welcome.playerId),
    tickRateHz: Number(msg.welcome.tickRateHz ?? 0),
  };
}

function sendAction(s: Socket, seq: number, actionKind: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { action: actionKind } }),
  ).finish();
  s.ws.send(bytes);
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

test("ServerWelcome reports the configured 20 Hz tick rate", async () => {
  const a = await openSocket();
  const wa = await readWelcome(a);
  expect(wa.tickRateHz).toBe(20);
  a.ws.close();
});

test("a ClientAction is reflected in a subsequent StateUpdate snapshot", async () => {
  // 20 Hz means snapshots arrive every ~50 ms. We'll wait up to ~5s for
  // the action to surface.
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  sendAction(a, 1, ACTION_MOVE_NORTH);
  sendAction(a, 2, ACTION_MOVE_EAST);

  // Wait for a StateUpdate where the local player is at (1, 1).
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const self = players.find((p) => p.id === me);
    return self !== undefined && self.x === 1 && self.y === 1;
  }, 5_000);

  a.ws.close();
});

test("two clients see each other move via StateUpdate broadcasts", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  await readWelcome(b);

  sendAction(a, 1, ACTION_MOVE_EAST);

  // B should see a StateUpdate containing A at x=1.
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const peer = players.find((p) => p.id === wa.playerId);
    return peer !== undefined && peer.x === 1 && peer.y === 0;
  }, 5_000);

  a.ws.close();
  b.ws.close();
});
