import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// BACKLOG task 020: per-player inventory wire surface. Pins (a) the
// post-Welcome `InventoryUpdate` carrying the 10-Gold starter, (b) the
// per-player isolation guarantee — a second connected client never sees
// the first client's inventory frame on the steady-state tick stream.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

const INVENTORY_SIZE = 45;
const ITEM_ID_GOLD = 4;

type Frame = { kind: "open" } | { kind: "msg"; data: Uint8Array } | { kind: "close"; code: number };

async function openSocket(timeoutMs = 5_000) {
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
      const timer = setTimeout(
        () => reject(new Error("timeout waiting for frame")),
        timeout,
      );
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

let helloSeq = 1000;

async function sendHello(
  ws: WebSocket,
  username: string,
  colorIndex = 0,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: { clientVersion: "anarchy-e2e", username, colorIndex, reconnect: false },
    }),
  ).finish();
  ws.send(bytes);
}

interface InventoryFrame {
  slots: { item: number; count: number }[];
}

function decodeInventory(frame: Extract<Frame, { kind: "msg" }>): InventoryFrame | null {
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    inventoryUpdate?: { slots?: { item?: string | number; count?: number }[] };
  };
  if (!msg.inventoryUpdate) return null;
  const slots = (msg.inventoryUpdate.slots ?? []).map((s) => ({
    item: typeof s.item === "string" ? itemNameToInt(s.item) : Number(s.item ?? 0),
    count: Number(s.count ?? 0),
  }));
  return { slots };
}

function itemNameToInt(name: string): number {
  switch (name) {
    case "ITEM_ID_STICK":
      return 1;
    case "ITEM_ID_WOOD":
      return 2;
    case "ITEM_ID_STONE":
      return 3;
    case "ITEM_ID_GOLD":
      return 4;
    default:
      return 0;
  }
}

test("server ships an InventoryUpdate carrying the 10-Gold starter after Welcome", async () => {
  const { ws, next } = await openSocket();
  await sendHello(ws, "starter-gold");

  // Welcome lands first (as a sanity check), then the InventoryUpdate.
  await next((f) => {
    if (f.kind !== "msg") return false;
    const m = ServerMessage.decode(f.data).toJSON() as { welcome?: unknown };
    return m.welcome !== undefined;
  });

  const inventoryFrame = (await next((f) => {
    if (f.kind !== "msg") return false;
    return decodeInventory(f as Extract<Frame, { kind: "msg" }>) !== null;
  })) as Extract<Frame, { kind: "msg" }>;

  const inventory = decodeInventory(inventoryFrame)!;
  expect(inventory.slots.length).toBe(INVENTORY_SIZE);
  // Slot 0 carries 10 Gold; remaining slots are canonical empty (count=0).
  expect(inventory.slots[0]).toEqual({ item: ITEM_ID_GOLD, count: 10 });
  for (let i = 1; i < INVENTORY_SIZE; i++) {
    expect(inventory.slots[i].count).toBe(0);
  }

  ws.close();
});

test("a second client only sees its own InventoryUpdate (per-player isolation)", async () => {
  // Two connected clients. Each sees its own post-Welcome inventory frame
  // exactly once. After that the steady-state stream is TickUpdates only —
  // neither client should observe additional InventoryUpdates flowing past
  // (no inventory mutations happen in this test).
  const a = await openSocket();
  await sendHello(a.ws, "iso-a");
  // Wait for A's welcome + initial inventory.
  await a.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeInventory(f as Extract<Frame, { kind: "msg" }>) !== null;
  });

  const b = await openSocket();
  await sendHello(b.ws, "iso-b");
  // Wait for B's welcome + initial inventory.
  await b.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeInventory(f as Extract<Frame, { kind: "msg" }>) !== null;
  });

  // Drain frames on both connections for ~600 ms (~12 ticks at 20 Hz).
  // Neither side should see another InventoryUpdate — only tick updates
  // and the like.
  const settle = 600;
  let aExtraInventory = 0;
  let bExtraInventory = 0;
  await Promise.all([
    new Promise<void>((resolve) => {
      const handler = (ev: MessageEvent) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const frame: Extract<Frame, { kind: "msg" }> = {
          kind: "msg",
          data: new Uint8Array(ev.data),
        };
        if (decodeInventory(frame)) aExtraInventory++;
      };
      a.ws.addEventListener("message", handler);
      setTimeout(() => {
        a.ws.removeEventListener("message", handler);
        resolve();
      }, settle);
    }),
    new Promise<void>((resolve) => {
      const handler = (ev: MessageEvent) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const frame: Extract<Frame, { kind: "msg" }> = {
          kind: "msg",
          data: new Uint8Array(ev.data),
        };
        if (decodeInventory(frame)) bExtraInventory++;
      };
      b.ws.addEventListener("message", handler);
      setTimeout(() => {
        b.ws.removeEventListener("message", handler);
        resolve();
      }, settle);
    }),
  ]);

  expect(aExtraInventory).toBe(0);
  expect(bExtraInventory).toBe(0);

  a.ws.close();
  b.ws.close();
});

test("client mirror absorbs the post-Welcome inventory through the bootstrap path", async ({
  page,
}) => {
  // End-to-end against the real client bootstrap (index.html + main.ts +
  // wire bridge). The `?username=&color=` query-string bypass skips the
  // lobby UI so this spec just asserts the inventory mirror was populated
  // by the post-Welcome `InventoryUpdate` frame.
  await page.goto("/?username=inv-bootstrap&color=0");
  await page.waitForFunction(() => window.__anarchy !== undefined);

  // Wait for the bootstrap test handle to carry the seeded 10 Gold.
  await page.waitForFunction(
    () => {
      const a = window.__anarchy;
      if (!a?.inventory) return false;
      return a.inventory.countOf(4) === 10;
    },
    undefined,
    { timeout: 10_000 },
  );

  const slot0 = await page.evaluate(() => {
    const a = window.__anarchy!;
    return a.inventory.slot(0);
  });
  expect(slot0).toEqual({ item: 4, count: 10 });
});
