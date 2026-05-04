import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Reconnect-admission e2e (BACKLOG: reconnect-checkbox flow). Pins the
// three branches in one place:
//
//   1. Round-trip: a Hello with `reconnect=true` whose username matches a
//      dormant record reuses the saved `PlayerId` and restores
//      position — proven by walking, disconnecting, and reconnecting,
//      then asserting the welcome carries the original id and the
//      first TickUpdate places the player at the saved coordinates.
//   2. Live-conflict reject: a Hello with `reconnect=true` whose
//      username is currently online is rejected with
//      `LOBBY_REJECT_REASON_RECONNECT_LIVE_SESSION`; the connection
//      closes immediately after the reject.
//   3. No-record reject: a Hello with `reconnect=true` whose username
//      has never been admitted is rejected with
//      `LOBBY_REJECT_REASON_RECONNECT_NO_RECORD`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");

const WS_URL = "ws://localhost:8080/ws";

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

let helloSeq = 1000;
async function sendHello(
  s: Socket,
  username: string,
  reconnect = false,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex: 0, reconnect },
    }),
  ).finish();
  s.ws.send(bytes);
}

interface DecodedWelcome {
  playerId: number;
}

async function awaitWelcome(s: Socket): Promise<DecodedWelcome> {
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

interface RejectPayload {
  reason: number;
}

async function awaitLobbyReject(s: Socket): Promise<RejectPayload> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { lobbyReject?: unknown };
    return m.lobbyReject !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    lobbyReject?: { reason?: number | string };
  };
  // protobufjs serializes int32 enums as the enum NAME by default in toJSON.
  // Map the names back to numeric reason codes for assertion clarity.
  const raw = msg.lobbyReject!.reason;
  const reason =
    typeof raw === "number"
      ? raw
      : raw === "LOBBY_REJECT_REASON_RECONNECT_LIVE_SESSION"
        ? 1
        : raw === "LOBBY_REJECT_REASON_RECONNECT_NO_RECORD"
          ? 2
          : 0;
  return { reason };
}

function sendIntent(s: Socket, seq: number, dx: number, dy: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { moveIntent: { dx, dy }, clientSeq: seq } }),
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

// Per-spec unique username so reruns / parallel workers do not race on
// the same dormant record across the shared default world. The server
// caps usernames at MAX_USERNAME_LEN (16), so we keep this short:
// `r-<random5>-<suffix3>` fits comfortably (`r-` 2 + 5 random + `-` 1 +
// up to 3-char suffix = 11 chars).
const RUN_ID = Math.random().toString(36).slice(2, 7);
const NAME_PREFIX = `r-${RUN_ID}`;

test("reconnect: round-trip restores PlayerId and a non-origin saved position", async () => {
  const username = `${NAME_PREFIX}-rt`;

  // First session: admit fresh, walk +x for a few ticks, halt intent so
  // momentum decays toward zero, then close.
  const a = await openSocket();
  await sendHello(a, username, false);
  const firstWelcome = await awaitWelcome(a);
  const firstId = firstWelcome.playerId;

  sendIntent(a, 200, 1.0, 0.0);
  await new Promise((r) => setTimeout(r, 600));
  sendIntent(a, 201, 0.0, 0.0);
  // Give the momentum amendment time to settle so the saved velocity is
  // ~zero — otherwise the post-reconnect tick would advance the player
  // again before the position assertion runs.
  await new Promise((r) => setTimeout(r, 600));

  a.ws.close();
  // Wait for the server-side `end_session` to fire and park the dormant
  // record before we attempt to reconnect.
  await new Promise((r) => setTimeout(r, 250));

  // Second session: reconnect under the same username. The welcome must
  // carry the same player id, and the first TickUpdate must place the
  // player at a positive x — proving the saved position survived the
  // dormant round-trip rather than the player respawning at origin.
  const b = await openSocket();
  await sendHello(b, username, true);
  const secondWelcome = await awaitWelcome(b);
  expect(secondWelcome.playerId).toBe(firstId);

  let restoredX: number | null = null;
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const players = readTickPlayers(f as Extract<Frame, { kind: "msg" }>);
    if (!players) return false;
    const me = players.find((p) => p.id === firstId);
    if (!me) return false;
    restoredX = me.x;
    return true;
  }, 5_000);
  expect(restoredX).not.toBeNull();
  expect(restoredX!).toBeGreaterThan(0.5);

  b.ws.close();
});

test("reconnect: rejected with LIVE_SESSION when username is online", async () => {
  const username = `${NAME_PREFIX}-live`;

  // First session stays online — admit fresh.
  const a = await openSocket();
  await sendHello(a, username, false);
  await awaitWelcome(a);

  // Second session attempts reconnect under the same username. The
  // server must reject with LOBBY_REJECT_REASON_RECONNECT_LIVE_SESSION
  // and close the socket.
  const b = await openSocket();
  await sendHello(b, username, true);
  const reject = await awaitLobbyReject(b);
  expect(reject.reason).toBe(1); // LOBBY_REJECT_REASON_RECONNECT_LIVE_SESSION
  await b.next((f) => f.kind === "close", 5_000);

  a.ws.close();
});

test("reconnect: rejected with NO_RECORD when no dormant record exists", async () => {
  const username = `${NAME_PREFIX}-nope`;

  const a = await openSocket();
  await sendHello(a, username, true);
  const reject = await awaitLobbyReject(a);
  expect(reject.reason).toBe(2); // LOBBY_REJECT_REASON_RECONNECT_NO_RECORD
  await a.next((f) => f.kind === "close", 5_000);
});
