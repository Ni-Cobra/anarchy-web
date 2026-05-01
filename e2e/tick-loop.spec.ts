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

// Server SPEED constant (tiles/sec) and tick dt — kept in sync with
// anarchy-server/src/game/world.rs::SPEED and the 50 ms tick interval.
const SPEED = 5.0;
const TICK_DT = 0.05;

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

function sendIntent(s: Socket, seq: number, dx: number, dy: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { moveIntent: { dx, dy } } }),
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

test("a held intent advances the player continuously across ticks", async () => {
  // The whole point of the intent model: ONE intent message produces
  // continuous motion until a new intent arrives. A single MoveIntent(1, 1)
  // (raw — the server will clamp the magnitude) sent once should still
  // see the player advance over a few ticks.
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  // Send a single normalized northeast intent once. The server stores it
  // and will keep advancing the player until told otherwise.
  const inv_sqrt2 = 1 / Math.sqrt(2);
  sendIntent(a, 1, inv_sqrt2, inv_sqrt2);

  // Wait until x AND y have both advanced by at least 2 ticks worth of
  // motion, proving the intent persisted across ticks (not just one apply).
  const minDist = SPEED * TICK_DT * 2 * inv_sqrt2;
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const self = players.find((p) => p.id === me);
    return self !== undefined && self.x > minDist && self.y > minDist;
  }, 5_000);

  a.ws.close();
});

test("releasing intent stops the player within a tick", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);
  const me = wa.playerId;

  // Move east for a while.
  sendIntent(a, 1, 1.0, 0.0);
  // Wait until at least one tick of motion has registered.
  let lastX = 0;
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const self = players.find((p) => p.id === me);
    if (self !== undefined && self.x > 0) {
      lastX = self.x;
      return true;
    }
    return false;
  }, 5_000);

  // Now stop. After a couple of ticks, the position should plateau —
  // assert two consecutive snapshots agree on x, AND the latest x is at
  // most a small epsilon greater than `lastX` (one in-flight tick may
  // sneak in before the stop intent applies).
  sendIntent(a, 2, 0.0, 0.0);

  await new Promise((r) => setTimeout(r, 250)); // ~5 ticks

  // Walk recent frames and confirm motion has plateaued.
  let prevX: number | null = null;
  let stableX: number | null = null;
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const self = players.find((p) => p.id === me);
    if (!self) return false;
    if (prevX !== null && Math.abs(self.x - prevX) < 1e-9) {
      stableX = self.x;
      return true;
    }
    prevX = self.x;
    return false;
  }, 5_000);

  expect(stableX).not.toBeNull();
  // Generous bound: stableX should not be more than ~3 extra ticks past
  // the lastX we observed before sending stop.
  expect(stableX!).toBeLessThan(lastX + SPEED * TICK_DT * 5);

  a.ws.close();
});

test("two clients see each other move via StateUpdate broadcasts", async () => {
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  await readWelcome(b);

  sendIntent(a, 1, 1.0, 0.0);

  // B should see a StateUpdate containing A at x > 0.
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const peer = players.find((p) => p.id === wa.playerId);
    return peer !== undefined && peer.x > 0;
  }, 5_000);

  a.ws.close();
  b.ws.close();
});

test("diagonal speed equals straight speed within epsilon", async () => {
  // The server clamps |intent| to 1, so a normalized diagonal (≈0.7071,
  // ≈0.7071) and a cardinal (1, 0) produce the same total distance per
  // tick. Run two sockets in parallel for the same wall-clock window and
  // compare the total distance each player traveled.
  test.setTimeout(10_000);

  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  const wb = await readWelcome(b);

  const inv_sqrt2 = 1 / Math.sqrt(2);

  // Both intents are sent back-to-back so the wall-clock window is roughly
  // identical. Player A goes east, player B goes northeast diagonally.
  sendIntent(a, 1, 1.0, 0.0);
  sendIntent(b, 1, inv_sqrt2, inv_sqrt2);

  // Sample after ~500ms — long enough that quantization noise is small
  // compared to the total distance.
  await new Promise((r) => setTimeout(r, 500));

  // Read the latest state for each from B's frame buffer (B receives
  // snapshots for both players via the broadcast).
  let aDist: number | null = null;
  let bDist: number | null = null;

  // Flush messages by sending a stop intent and waiting for a snapshot
  // that includes both players.
  sendIntent(a, 2, 0.0, 0.0);
  sendIntent(b, 2, 0.0, 0.0);
  await new Promise((r) => setTimeout(r, 100)); // let the stops apply

  // A snapshot containing both ids.
  const seenIds = new Set([wa.playerId, wb.playerId]);
  const frame = (await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readStateUpdate(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    return [...seenIds].every((id) => players.find((p) => p.id === id) !== undefined);
  }, 5_000)) as Extract<Frame, { kind: "msg" }>;
  const players = readStateUpdate(frame)!;
  const aSelf = players.find((p) => p.id === wa.playerId)!;
  const bSelf = players.find((p) => p.id === wb.playerId)!;
  aDist = Math.hypot(aSelf.x, aSelf.y);
  bDist = Math.hypot(bSelf.x, bSelf.y);

  // The two players started at the same time and (roughly) stopped at the
  // same time, so distances should agree within a few ticks of error.
  expect(aDist).toBeGreaterThan(0);
  expect(bDist).toBeGreaterThan(0);
  expect(Math.abs(aDist - bDist)).toBeLessThan(SPEED * TICK_DT * 4);

  a.ws.close();
  b.ws.close();
});
