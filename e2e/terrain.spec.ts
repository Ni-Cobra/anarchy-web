import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Wire-level e2e for the terrain protocol. Pins the two assertions called
// out by the BACKLOG: (a) a fresh joining client receives a TerrainSnapshot
// with the four default chunks before any other terrain payload, and (b)
// when one player walks far enough to cross a chunk boundary, the radius-
// based loader broadcasts ChunkLoaded events for the newly-pulled-in
// chunks and the *other* connected client receives them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

// Mirrors of server-side constants. Keep in sync with anarchy-server's
// `config::CHUNK_LOAD_RADIUS` and the terrain layer dimensions in
// `game::terrain` (`LAYER_SIZE = 16`, `LAYER_AREA = 256`).
const CHUNK_LOAD_RADIUS = 2;
const LAYER_SIZE = 16;
const LAYER_AREA = LAYER_SIZE * LAYER_SIZE;
const CHUNK_SIZE = LAYER_SIZE;

// The four chunks the server seeds at startup and never unloads. Chosen so
// the world origin (0, 0) sits at their shared corner — see ADR 0002 §5.
const DEFAULT_CHUNK_COORDS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [0, -1],
  [0, 0],
];

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
  return { ws, next };
}

interface DecodedTerrainSnapshot {
  chunks: { x: number; y: number; ground: number; top: number }[];
}

function decodeServerMessage(data: Uint8Array): {
  welcome?: { playerId?: string | number };
  terrainSnapshot?: {
    chunks?: {
      x?: number;
      y?: number;
      ground?: { blocks?: { kind?: number }[] };
      top?: { blocks?: { kind?: number }[] };
    }[];
  };
  chunkLoaded?: {
    chunk?: {
      x?: number;
      y?: number;
      ground?: { blocks?: { kind?: number }[] };
      top?: { blocks?: { kind?: number }[] };
    };
  };
  chunkUnloaded?: { x?: number; y?: number };
  stateUpdate?: {
    snapshot?: { players?: { id?: string | number; x?: number; y?: number }[] };
  };
} {
  return ServerMessage.decode(data).toJSON();
}

// Strict predicates: `next` is `find`-based over a shared frame buffer, so
// repeated `f.kind === "msg"` lookups would return the same frame. Match
// on the decoded payload's specific oneof field instead.
async function readWelcome(s: Socket): Promise<number> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeServerMessage(f.data).welcome !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = decodeServerMessage(frame.data);
  return Number(msg.welcome!.playerId);
}

async function readTerrainSnapshot(s: Socket): Promise<DecodedTerrainSnapshot> {
  const frame = (await s.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeServerMessage(f.data).terrainSnapshot !== undefined;
  })) as Extract<Frame, { kind: "msg" }>;
  const msg = decodeServerMessage(frame.data);
  const chunks = (msg.terrainSnapshot!.chunks ?? []).map((c) => ({
    x: Number(c.x ?? 0),
    y: Number(c.y ?? 0),
    ground: (c.ground?.blocks ?? []).length,
    top: (c.top?.blocks ?? []).length,
  }));
  return { chunks };
}

function sendIntent(s: Socket, seq: number, dx: number, dy: number) {
  const bytes = ClientMessage.encode(
    ClientMessage.create({ seq, action: { moveIntent: { dx, dy }, clientSeq: seq } }),
  ).finish();
  s.ws.send(bytes);
}

test("a joining client receives a TerrainSnapshot with the four default chunks", async () => {
  const a = await openSocket();
  await readWelcome(a);

  const snap = await readTerrainSnapshot(a);
  // The four startup defaults are present at world creation, before any tick
  // can fire to load a player's neighborhood — so a brand-new server's first
  // joiner sees exactly these four. (Re-running against an already-warm
  // server may show more chunks loaded around an existing player; this
  // assertion only requires the defaults to be present and the layers to be
  // well-formed, both of which are invariants the wire owes every joiner.)
  const coords = snap.chunks.map((c) => [c.x, c.y] as const);
  for (const [cx, cy] of DEFAULT_CHUNK_COORDS) {
    expect(coords).toContainEqual([cx, cy]);
  }
  // Every chunk on the wire must carry both layers, each with exactly
  // LAYER_AREA blocks. proto3 has no fixed-size repeated, so the receiver
  // contract (and the wire's own tests) pin the length explicitly.
  for (const c of snap.chunks) {
    expect(c.ground).toBe(LAYER_AREA);
    expect(c.top).toBe(LAYER_AREA);
  }

  a.ws.close();
});

test("crossing a chunk boundary broadcasts ChunkLoaded to other clients", async () => {
  // The point of the radius-based loader: when one player walks far enough
  // for their neighborhood to overlap a previously-unknown chunk, the
  // server generates that chunk and broadcasts a ChunkLoaded event. Every
  // *other* connected client must see it on the wire so they can ingest it
  // into their local Terrain — that is what this test pins.
  test.setTimeout(15_000);

  const a = await openSocket();
  await readWelcome(a);
  await readTerrainSnapshot(a);

  const b = await openSocket();
  await readWelcome(b);
  // B's TerrainSnapshot is captured after A's spawn + first-tick reconcile,
  // so it already includes A's radius-2 ball. Drain it; B's set of "known"
  // chunks for the assertion below is whatever was in this snapshot.
  const bSnap = await readTerrainSnapshot(b);
  const knownToB = new Set(bSnap.chunks.map((c) => `${c.x},${c.y}`));

  // A walks east at full speed. Both A and B start at (0, 0) — chunk (0, 0)
  // — so the union neighborhood spans chunk x ∈ [-2, 2]. Once A crosses
  // into chunk (1, 0), A's neighborhood becomes x ∈ [-1, 3], pulling chunks
  // at x=3 into the union. Those are the ChunkLoaded events B should see.
  // Distance to cross: A's chunk flips at world x = CHUNK_SIZE = 16.
  sendIntent(a, 1, 1.0, 0.0);

  // Wait until a StateUpdate confirms A's x ≥ CHUNK_SIZE (so we know the
  // boundary-crossing tick has fired) AND the first new ChunkLoaded for a
  // chunk B didn't already know about has been broadcast.
  let crossed = false;
  let observedNewLoad: { x: number; y: number } | null = null;

  await b.next((f) => {
    if (f.kind !== "msg") return false;
    const msg = decodeServerMessage(f.data);

    if (msg.stateUpdate) {
      const me = (msg.stateUpdate.snapshot?.players ?? []).find(
        (p) => Number(p.x ?? 0) >= CHUNK_SIZE,
      );
      if (me) crossed = true;
    }

    if (msg.chunkLoaded?.chunk) {
      const cx = Number(msg.chunkLoaded.chunk.x ?? 0);
      const cy = Number(msg.chunkLoaded.chunk.y ?? 0);
      const ground = (msg.chunkLoaded.chunk.ground?.blocks ?? []).length;
      const top = (msg.chunkLoaded.chunk.top?.blocks ?? []).length;
      // The wire owes every chunk both layers at full LAYER_AREA length.
      // Pin it here so a regression on either layer surfaces clearly.
      if (ground !== LAYER_AREA || top !== LAYER_AREA) {
        throw new Error(
          `malformed ChunkLoaded for (${cx}, ${cy}): ground=${ground}, top=${top}`,
        );
      }
      if (!knownToB.has(`${cx},${cy}`)) {
        observedNewLoad = { x: cx, y: cy };
      }
    }

    return crossed && observedNewLoad !== null;
  }, 12_000);

  expect(crossed).toBe(true);
  expect(observedNewLoad).not.toBeNull();
  // Tighter pin on the geometry: the new chunks induced by A's eastward
  // crossing must be in the column just east of A's previous neighborhood
  // (x=3 at radius 2 around the new chunk (1, 0)).
  expect(observedNewLoad!.x).toBe(CHUNK_LOAD_RADIUS + 1);
  expect(Math.abs(observedNewLoad!.y)).toBeLessThanOrEqual(CHUNK_LOAD_RADIUS);

  // Stop A so the next test (if any in this file) doesn't inherit motion.
  sendIntent(a, 2, 0.0, 0.0);

  a.ws.close();
  b.ws.close();
});
