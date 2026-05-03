import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Advanced wire-level e2e for the chunk-centric networking model (ADR 0003).
// The basic per-tick shape is pinned in `tick-loop.spec.ts` / `terrain.spec.ts`
// / `spawn-despawn.spec.ts`; these cases exercise the harder edges:
//   1. Two clients separating across the view-radius boundary — each appears
//      in the other's tick stream while their windows overlap, and is
//      implicitly unloaded once the windows are disjoint.
//   2. Interest filtering: a fresh joiner whose window does not overlap a
//      far-away player's chunk never receives any chunk carrying them.
//   3. Repeated chunk-boundary crossings don't drop player state — the
//      player keeps appearing in exactly one chunk's full-state per tick
//      and the connection survives.
//   4. Reconnect rebuilds the full view window from empty `known` — the
//      first `TickUpdate` after a fresh connect always carries the entire
//      (2r+1)² window as full-state, even when the same physical client
//      reconnects after an earlier disconnect.
//   5. The first-tick payload (full window of full-state chunks) fits
//      comfortably under the inbound framing budget — no client risks
//      tripping the same `MAX_INBOUND_MESSAGE_SIZE` bound on the way back.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

const VIEW_RADIUS_CHUNKS = 2;
const VIEW_WINDOW_AREA = (2 * VIEW_RADIUS_CHUNKS + 1) ** 2;
const CHUNK_SIZE = 16;
const SPEED = 5.0;
// Mirrors `MAX_INBOUND_MESSAGE_SIZE` in anarchy-server/src/config.rs. The
// server enforces this on the way *in*; the same budget makes a useful
// ceiling for outbound `TickUpdate`s so a hostile chunk count or block
// alphabet can't grow the payload past what any party's transport will
// accept.
const MAX_FRAME_BYTES = 64 * 1024;

type Frame =
  | { kind: "open" }
  | { kind: "msg"; data: Uint8Array }
  | { kind: "close"; code: number };

interface Socket {
  ws: WebSocket;
  frames: Frame[];
  next: (predicate: (f: Frame) => boolean, timeout?: number) => Promise<Frame>;
}

async function openSocket(timeoutMs = 5_000): Promise<Socket> {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  const frames: Frame[] = [];
  const waiters: Array<{
    predicate: (f: Frame) => boolean;
    resolve: (f: Frame) => void;
  }> = [];

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
    if (ev.data instanceof ArrayBuffer) {
      push({ kind: "msg", data: new Uint8Array(ev.data) });
    }
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

interface DecodedTick {
  fullStateChunks: {
    cx: number;
    cy: number;
    groundLen: number;
    topLen: number;
    playerIds: number[];
    players: { id: number; x: number; y: number }[];
  }[];
  unmodifiedChunks: { cx: number; cy: number }[];
}

function decodeTickUpdate(data: Uint8Array): DecodedTick | null {
  const msg = ServerMessage.decode(data).toJSON() as {
    tickUpdate?: {
      fullStateChunks?: {
        coord?: { cx?: number; cy?: number };
        ground?: { blocks?: unknown[] };
        top?: { blocks?: unknown[] };
        players?: { id?: string | number; x?: number; y?: number }[];
      }[];
      unmodifiedChunks?: { cx?: number; cy?: number }[];
    };
  };
  if (!msg.tickUpdate) return null;
  return {
    fullStateChunks: (msg.tickUpdate.fullStateChunks ?? []).map((c) => ({
      cx: Number(c.coord?.cx ?? 0),
      cy: Number(c.coord?.cy ?? 0),
      groundLen: (c.ground?.blocks ?? []).length,
      topLen: (c.top?.blocks ?? []).length,
      playerIds: (c.players ?? []).map((p) => Number(p.id)),
      players: (c.players ?? []).map((p) => ({
        id: Number(p.id),
        x: Number(p.x ?? 0),
        y: Number(p.y ?? 0),
      })),
    })),
    unmodifiedChunks: (msg.tickUpdate.unmodifiedChunks ?? []).map((c) => ({
      cx: Number(c.cx ?? 0),
      cy: Number(c.cy ?? 0),
    })),
  };
}

async function readWelcomePlayerId(s: Socket): Promise<number> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { welcome?: unknown };
    return m.welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    welcome?: { playerId?: string | number };
  };
  await sendHello(s);
  return Number(msg.welcome!.playerId);
}

let helloSeq = 100;
async function sendHello(s: Socket, username = "tester", colorIndex = 0): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex },
    }),
  ).finish();
  s.ws.send(bytes);
}

function sendIntent(s: Socket, seq: number, dx: number, dy: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { moveIntent: { dx, dy }, clientSeq: seq } }),
  ).finish();
  s.ws.send(bytes);
}

function tickFramesContainingPlayer(s: Socket, playerId: number): number {
  let count = 0;
  for (const f of s.frames) {
    if (f.kind !== "msg") continue;
    const tick = decodeTickUpdate(f.data);
    if (!tick) continue;
    const seen = tick.fullStateChunks.some((c) => c.playerIds.includes(playerId));
    if (seen) count++;
  }
  return count;
}

test("two clients walking apart see each other appear and then implicitly unload as their windows separate", async () => {
  // Both spawn at origin (chunk 0, 0) so their view windows initially
  // overlap fully — each must appear in the other's tick stream. They
  // walk in opposite directions at SPEED until their chunks are more
  // than 2*VIEW_RADIUS apart along x; from that moment the moving
  // player's chunk is outside the receiver's window, so the implicit-
  // unload rule (ADR 0003) drops the chunk and the player along with
  // it from the receiver's tick stream.
  test.setTimeout(25_000);

  const a = await openSocket();
  const aId = await readWelcomePlayerId(a);
  const b = await openSocket();
  const bId = await readWelcomePlayerId(b);
  expect(aId).not.toBe(bId);

  // Both must show each other in some tick before they separate.
  // Capture each player's post-spawn position from that tick — both
  // spawn at origin and the player↔player push pass shoves them apart
  // along x, so we send each one further along the side they were
  // pushed to. (Walking *into* each other from the same spawn would
  // just oscillate against the push.)
  let posA: { x: number; y: number } | null = null;
  let posB: { x: number; y: number } | null = null;
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    if (!t) return false;
    for (const c of t.fullStateChunks) {
      for (const p of c.players) {
        if (p.id === aId) posA = { x: p.x, y: p.y };
        if (p.id === bId) posB = { x: p.x, y: p.y };
      }
    }
    return posA !== null && posB !== null;
  }, 5_000);
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    return !!t && t.fullStateChunks.some((c) => c.playerIds.includes(aId));
  }, 5_000);

  // Walk each player further along its post-push side. Separation grows
  // at 2*SPEED = 10 u/s. After ~8s their chunks (cx≈±3) sit outside
  // each other's (2r+1)=5-wide windows.
  const aDir = posA!.x <= posB!.x ? -1 : 1;
  const bDir = -aDir;
  sendIntent(a, 1, aDir, 0.0);
  sendIntent(b, 1, bDir, 0.0);
  const aChunkPast = aDir > 0 ? 3 : -3;
  const bChunkPast = bDir > 0 ? 3 : -3;

  // Wait for B to drop out of A's stream. Past separation, every
  // TickUpdate to A contains only A's window and B's chunk no longer fits.
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    if (!t) return false;
    // A "post-separation" tick: B not present anywhere AND A's center
    // chunk is past the threshold (so windows really are disjoint, not
    // just an unmodified-chunk tick that happens not to mention B).
    const carriesA = t.fullStateChunks.find((c) => c.playerIds.includes(aId));
    const carriesB = t.fullStateChunks.some((c) => c.playerIds.includes(bId));
    if (carriesB) return false;
    if (!carriesA) return false;
    return aDir > 0 ? carriesA.cx >= aChunkPast : carriesA.cx <= aChunkPast;
  }, 18_000);

  // Symmetrically: A out of B's stream once B's chunk has slid the other way.
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    if (!t) return false;
    const carriesB = t.fullStateChunks.find((c) => c.playerIds.includes(bId));
    const carriesA = t.fullStateChunks.some((c) => c.playerIds.includes(aId));
    if (carriesA) return false;
    if (!carriesB) return false;
    return bDir > 0 ? carriesB.cx >= bChunkPast : carriesB.cx <= bChunkPast;
  }, 18_000);

  a.ws.close();
  b.ws.close();
});

test("a fresh joiner whose view window does not include a far-away player never receives that player's chunk", async () => {
  // A walks east long enough to leave the origin's view window. Then a
  // second client C connects at origin. C's window is cx=-2..=2; A's
  // chunk is cx≥3. The chunk A occupies is therefore never eligible for
  // delivery to C — interest filtering must keep it out across many
  // ticks.
  test.setTimeout(25_000);

  const a = await openSocket();
  const aId = await readWelcomePlayerId(a);

  sendIntent(a, 1, 1.0, 0.0);

  // Wait until A's chunk reports cx >= 3 in one of A's own ticks.
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    if (!t) return false;
    const own = t.fullStateChunks.find((c) => c.playerIds.includes(aId));
    return !!own && own.cx >= 3;
  }, 15_000);

  // Now connect a fresh client. C must never see A in any of its ticks.
  const c = await openSocket();
  const cId = await readWelcomePlayerId(c);
  expect(cId).not.toBe(aId);

  // Drain the joining tick + at least four follow-up ticks (≥200 ms at
  // 20 Hz) so the assertion has multiple per-client compositions to
  // disagree with if interest filtering broke.
  let cTicks = 0;
  const deadline = Date.now() + 1_500;
  while (cTicks < 5 && Date.now() < deadline) {
    await c.next((f) => {
      if (f.kind !== "msg") return false;
      const t = decodeTickUpdate(f.data);
      if (!t) return false;
      cTicks++;
      return true;
    }, 1_500);
  }
  expect(cTicks).toBeGreaterThanOrEqual(5);

  // Across every TickUpdate C received, A's id must not appear in any
  // chunk's player set, and no chunk delivered to C may have cx > 2.
  for (const f of c.frames) {
    if (f.kind !== "msg") continue;
    const t = decodeTickUpdate(f.data);
    if (!t) continue;
    for (const ch of t.fullStateChunks) {
      expect(ch.playerIds).not.toContain(aId);
      expect(ch.cx).toBeLessThanOrEqual(VIEW_RADIUS_CHUNKS);
      expect(ch.cx).toBeGreaterThanOrEqual(-VIEW_RADIUS_CHUNKS);
      expect(ch.cy).toBeLessThanOrEqual(VIEW_RADIUS_CHUNKS);
      expect(ch.cy).toBeGreaterThanOrEqual(-VIEW_RADIUS_CHUNKS);
    }
    for (const u of t.unmodifiedChunks) {
      expect(u.cx).toBeLessThanOrEqual(VIEW_RADIUS_CHUNKS);
      expect(u.cx).toBeGreaterThanOrEqual(-VIEW_RADIUS_CHUNKS);
      expect(u.cy).toBeLessThanOrEqual(VIEW_RADIUS_CHUNKS);
      expect(u.cy).toBeGreaterThanOrEqual(-VIEW_RADIUS_CHUNKS);
    }
  }

  a.ws.close();
  c.ws.close();
});

test("rapid back-and-forth across a chunk boundary keeps player state consistent and the connection alive", async () => {
  // The view-window slide on each chunk cross loads/unloads a column of
  // chunks. Pin: across many crossings, the player is always in
  // exactly one chunk's player set, the connection never closes, and
  // the player's reported (cx, cy) coords stay within the band the
  // physics allow.
  test.setTimeout(20_000);

  const a = await openSocket();
  const aId = await readWelcomePlayerId(a);

  // Walk east continuously for long enough to cross x=16 (boundary
  // between cx=0 and cx=1). At SPEED=5 a single direction phase of 4 s
  // covers 20 units, comfortably across the boundary.
  let seq = 1;
  const phaseMs = 4_000;
  const phases = 4; // east, west, east, west
  for (let i = 0; i < phases; i++) {
    const dx = i % 2 === 0 ? 1.0 : -1.0;
    sendIntent(a, seq++, dx, 0.0);
    await new Promise((r) => setTimeout(r, phaseMs));
  }
  // Stop. Drain a couple of ticks to land in steady state.
  sendIntent(a, seq++, 0.0, 0.0);
  await new Promise((r) => setTimeout(r, 200));

  // Connection still open.
  expect(a.ws.readyState).toBe(WebSocket.OPEN);
  expect(a.frames.some((f) => f.kind === "close")).toBe(false);

  // Across every TickUpdate received: A appears in at most one chunk
  // per tick, and that chunk's (cx, cy) is consistent with the player
  // x ∈ [-30, 30], y == 0 envelope (round-trip of ~5*4=20 either way
  // from origin). We allow cx ∈ [-2, 2] as a generous cushion.
  let ticksWithA = 0;
  for (const f of a.frames) {
    if (f.kind !== "msg") continue;
    const t = decodeTickUpdate(f.data);
    if (!t) continue;
    const carriers = t.fullStateChunks.filter((c) => c.playerIds.includes(aId));
    expect(carriers.length).toBeLessThanOrEqual(1);
    if (carriers.length === 1) {
      ticksWithA++;
      const carrier = carriers[0];
      // Player x derived from world-coord chunk floor must match.
      const self = carrier.players.find((p) => p.id === aId)!;
      expect(Math.floor(self.x / CHUNK_SIZE)).toBe(carrier.cx);
      expect(Math.floor(self.y / CHUNK_SIZE)).toBe(carrier.cy);
      // y never moved.
      expect(self.y).toBeCloseTo(0, 5);
      // x stays within the physics envelope.
      expect(self.x).toBeGreaterThan(-(SPEED * phaseMs / 1000) * 1.5);
      expect(self.x).toBeLessThan((SPEED * phaseMs / 1000) * 1.5);
    }
  }
  expect(ticksWithA).toBeGreaterThan(0);

  a.ws.close();
});

test("reconnect rebuilds the full view window from an empty known set", async () => {
  // The server keeps `known_chunks` per-connection; a fresh connect (or
  // reconnect) starts that set empty and the first TickUpdate after the
  // Welcome must therefore ship every chunk in the new player's view
  // window as full-state. Pin this for the reconnect path explicitly.
  test.setTimeout(15_000);

  const first = await openSocket();
  const firstId = await readWelcomePlayerId(first);

  const firstTick = (await first.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    return !!t;
  }, 5_000)) as Extract<Frame, { kind: "msg" }>;
  const decodedFirst = decodeTickUpdate(firstTick.data)!;
  expect(decodedFirst.fullStateChunks.length).toBe(VIEW_WINDOW_AREA);
  expect(decodedFirst.unmodifiedChunks.length).toBe(0);

  // Drop the connection — the server's per-conn state (including the
  // `known_chunks` set) goes with it.
  first.ws.close();
  // Wait for the close to be observed before reconnecting so the
  // server has a chance to despawn / unregister.
  await first.next((f) => f.kind === "close", 5_000);
  await new Promise((r) => setTimeout(r, 100));

  const second = await openSocket();
  const secondId = await readWelcomePlayerId(second);
  // Reconnect lands as a brand-new player id (no resume semantics yet).
  expect(secondId).not.toBe(firstId);

  const secondTick = (await second.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    return !!t;
  }, 5_000)) as Extract<Frame, { kind: "msg" }>;
  const decodedSecond = decodeTickUpdate(secondTick.data)!;
  expect(decodedSecond.fullStateChunks.length).toBe(VIEW_WINDOW_AREA);
  expect(decodedSecond.unmodifiedChunks.length).toBe(0);

  // Both layers populated end-to-end on every reconnect chunk.
  for (const c of decodedSecond.fullStateChunks) {
    expect(c.groundLen).toBe(CHUNK_SIZE * CHUNK_SIZE);
    expect(c.topLen).toBe(CHUNK_SIZE * CHUNK_SIZE);
  }

  void tickFramesContainingPlayer; // silence unused-helper warning
  second.ws.close();
});

test("the joining tick fits in a single frame well under the inbound size budget", async () => {
  // The first tick after Welcome carries the entire (2r+1)² window as
  // full-state; pin that this payload arrives as one WebSocket frame
  // and stays comfortably under MAX_INBOUND_MESSAGE_SIZE so a future
  // proto growth that bloats per-block bytes shows up here before it
  // hits a real deployment.
  test.setTimeout(10_000);

  const a = await openSocket();
  await readWelcomePlayerId(a);

  const tickFrame = (await a.next((f) => {
    if (f.kind !== "msg") return false;
    const t = decodeTickUpdate(f.data);
    return !!t;
  }, 5_000)) as Extract<Frame, { kind: "msg" }>;

  const decoded = decodeTickUpdate(tickFrame.data)!;
  expect(decoded.fullStateChunks.length).toBe(VIEW_WINDOW_AREA);
  expect(decoded.unmodifiedChunks.length).toBe(0);

  // Single frame: by construction `next` resolves on one `msg` event,
  // and the test_helper sets `binaryType = arraybuffer` so the entire
  // payload is in this `Uint8Array`.
  expect(tickFrame.data.length).toBeGreaterThan(0);
  expect(tickFrame.data.length).toBeLessThan(MAX_FRAME_BYTES);

  a.ws.close();
});
