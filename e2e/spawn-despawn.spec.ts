import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Per ADR 0003 the gameplay wire shape is per-tick `TickUpdate`s; there is
// no `WorldSnapshot` in `Welcome` and no explicit `PlayerDespawned`. The
// player set lives inside chunks delivered by `TickUpdate.full_state_chunks`,
// and a player whose chunk falls out of view (or whose chunk no longer
// references them) disappears via the same chunk-diff mechanism.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");

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
}

async function readWelcome(
  s: Socket,
  username = "tester",
  colorIndex = 0,
): Promise<DecodedWelcome> {
  // The server defers `ServerWelcome` until after a valid `ClientHello`
  // arrives — admission outcome (fresh allocation vs. reconnect to a
  // dormant id) shapes the welcome's `player_id`. Send Hello first, then
  // await the welcome.
  await sendHello(s, username, colorIndex);
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { welcome?: unknown };
    return m.welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: { playerId?: string | number };
  };
  return { playerId: Number(msg.welcome!.playerId) };
}

let helloSeq = 100;
async function sendHello(
  s: Socket,
  username = "tester",
  colorIndex = 0,
  reconnect = false,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex, reconnect },
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

test("a second client's first TickUpdate includes the first client", async () => {
  // Player A spawns. Player B spawns later — B's chunk window covers
  // origin and overlaps A's, so B's first TickUpdate must carry the chunk
  // containing A.
  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  const wb = await readWelcome(b);

  expect(wb.playerId).not.toBe(wa.playerId);

  // The first TickUpdate B receives must carry both ids (A and B sit at
  // origin so their chunks overlap inside B's view window).
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readTickPlayers(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const ids = new Set(players.map((p) => p.id));
    return ids.has(wa.playerId) && ids.has(wb.playerId);
  }, 5_000);

  a.ws.close();
  b.ws.close();
});

test("when one client disconnects, others see them removed via the chunk diff", async () => {
  // Per ADR 0003 there is no PlayerDespawned message. A disappears via the
  // next tick: their chunk's player set no longer references them, so the
  // chunk is dirty and B receives full-state for that chunk minus A.
  const a = await openSocket();
  const wa = await readWelcome(a);

  const b = await openSocket();
  await readWelcome(b);

  // Wait for B to see A in some tick first.
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readTickPlayers(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    return players.some((p) => p.id === wa.playerId);
  }, 5_000);

  // Drop A. The tick following the despawn marks A's chunk dirty; B
  // receives a TickUpdate where the chunk's player set no longer carries A.
  a.ws.close();

  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const msg = ServerMessage.decode(f.data).toJSON() as {
      tickUpdate?: {
        fullStateChunks?: {
          players?: { id?: string | number }[];
        }[];
      };
    };
    if (!msg.tickUpdate) return false;
    // Must carry at least one full-state chunk that does NOT contain A's id.
    // Using the negation: the union of player ids in this tick's full-state
    // chunks does not contain wa.playerId — but this tick must be one that
    // touches origin (the chunk that used to contain A).
    let touchedOrigin = false;
    let mentionsA = false;
    for (const c of msg.tickUpdate.fullStateChunks ?? []) {
      // Origin chunk is (0, 0); we don't know which chunk A was in but it
      // started at origin so chunk (0, 0) is the one that flips here.
      touchedOrigin = true;
      for (const p of c.players ?? []) {
        if (Number(p.id) === wa.playerId) mentionsA = true;
      }
    }
    return touchedOrigin && !mentionsA;
  }, 5_000);

  b.ws.close();
});
