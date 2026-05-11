import { test, expect } from "@playwright/test";
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// BACKLOG task 100: pickaxe / axe equipment slots. End-to-end test that
// the wire round-trip works (`EquipTool` lands an `InventoryUpdate` with
// the equipped tool field populated) and that the equipped state survives
// a reconnect (the dormant record carries the equipment slots forward
// across the disconnect → re-Hello flow).

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../proto/anarchy/v1/anarchy.proto");

const root = await protobuf.load(PROTO_PATH);
const ClientMessage = root.lookupType("anarchy.v1.ClientMessage");
const ServerMessage = root.lookupType("anarchy.v1.ServerMessage");

const WS_URL = "ws://localhost:8080/ws";

const HOTBAR_SLOTS = 9;
const ITEM_ID_WOOD_PICKAXE = 5;
const ITEM_ID_WOOD_AXE = 10;
// Wire numeric for `ToolKind`. UNSPECIFIED = 0, PICKAXE = 1, AXE = 2.
const TOOL_KIND_PICKAXE = 1;
const TOOL_KIND_AXE = 2;
// Starter loadout panel slots from `STARTER_TOOL_LOADOUT` (see
// `anarchy-server/src/network/hub.rs`). Wood pickaxe lives at panel slot
// 26 (flat 35); wood axe at panel slot 31 (flat 40).
const WOOD_PICKAXE_SLOT = HOTBAR_SLOTS + 26;
const WOOD_AXE_SLOT = HOTBAR_SLOTS + 31;

type Frame =
  | { kind: "open" }
  | { kind: "msg"; data: Uint8Array }
  | { kind: "close"; code: number };

async function openSocket(timeoutMs = 5_000) {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  // Frames buffer + monotonic cursor: each `next()` resolves with the
  // first frame at or after `cursor` matching the predicate, then
  // advances the cursor past it. This makes `next` strictly forward —
  // important for tests that wait for the *next* inventory frame after
  // a wire action, not the one the welcome handshake already shipped.
  const frames: Frame[] = [];
  let cursor = 0;
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
    if (ev.data instanceof ArrayBuffer)
      push({ kind: "msg", data: new Uint8Array(ev.data) });
  });
  ws.addEventListener("close", (ev) => push({ kind: "close", code: ev.code }));

  function next(
    predicate: (f: Frame) => boolean,
    timeout = timeoutMs,
  ): Promise<Frame> {
    for (let i = cursor; i < frames.length; i++) {
      if (predicate(frames[i])) {
        cursor = i + 1;
        return Promise.resolve(frames[i]);
      }
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timeout waiting for frame")),
        timeout,
      );
      waiters.push({
        predicate: (f) => {
          if (predicate(f)) {
            clearTimeout(timer);
            cursor = frames.length; // we just consumed the last frame
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

let helloSeq = 2000;

async function sendHello(
  ws: WebSocket,
  username: string,
  reconnect = false,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      hello: {
        clientVersion: "anarchy-e2e",
        username,
        colorIndex: 0,
        reconnect,
      },
    }),
  ).finish();
  ws.send(bytes);
}

async function sendEquipTool(
  ws: WebSocket,
  sourceSlot: number,
  toolKind: number,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      equipTool: { sourceSlot, toolKind, clientSeq: 1 },
    }),
  ).finish();
  ws.send(bytes);
}

async function sendUnequipTool(
  ws: WebSocket,
  toolKind: number,
): Promise<void> {
  const bytes = ClientMessage.encode(
    ClientMessage.create({
      seq: helloSeq++,
      unequipTool: { toolKind, clientSeq: 1 },
    }),
  ).finish();
  ws.send(bytes);
}

interface InventoryFrame {
  slots: { item: number; count: number }[];
  equippedPickaxeSlot: number;
  equippedAxeSlot: number;
}

function decodeInventory(
  frame: Extract<Frame, { kind: "msg" }>,
): InventoryFrame | null {
  const msg = ServerMessage.decode(frame.data).toJSON() as {
    inventoryUpdate?: {
      slots?: { item?: string | number; count?: number }[];
      equippedPickaxeSlot?: number;
      equippedAxeSlot?: number;
    };
  };
  if (!msg.inventoryUpdate) return null;
  const decodeSlot = (s: {
    item?: string | number;
    count?: number;
  }): { item: number; count: number } => ({
    item: typeof s.item === "string" ? itemNameToInt(s.item) : Number(s.item ?? 0),
    count: Number(s.count ?? 0),
  });
  return {
    slots: (msg.inventoryUpdate.slots ?? []).map(decodeSlot),
    // Task 010 rework: equipment is a slot index, not an `ItemSlot`. `-1`
    // (or proto3 default `0` when the field was never set... actually
    // no, JSON encoding is explicit about absent vs zero) means
    // "nothing equipped"; otherwise the index of the equipped tool's
    // cell in `slots`. Default to `-1` defensively when the field is
    // missing.
    equippedPickaxeSlot: Number(msg.inventoryUpdate.equippedPickaxeSlot ?? -1),
    equippedAxeSlot: Number(msg.inventoryUpdate.equippedAxeSlot ?? -1),
  };
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
    case "ITEM_ID_WOOD_PICKAXE":
      return 5;
    case "ITEM_ID_STONE_PICKAXE":
      return 6;
    case "ITEM_ID_COPPER_PICKAXE":
      return 7;
    case "ITEM_ID_IRON_PICKAXE":
      return 8;
    case "ITEM_ID_TUNGSTEN_PICKAXE":
      return 9;
    case "ITEM_ID_WOOD_AXE":
      return 10;
    case "ITEM_ID_STONE_AXE":
      return 11;
    case "ITEM_ID_COPPER_AXE":
      return 12;
    case "ITEM_ID_IRON_AXE":
      return 13;
    case "ITEM_ID_TUNGSTEN_AXE":
      return 14;
    default:
      return 0;
  }
}

async function waitForInventory(socket: {
  next: (
    predicate: (f: Frame) => boolean,
    timeout?: number,
  ) => Promise<Frame>;
}): Promise<InventoryFrame> {
  const f = (await socket.next((f) => {
    if (f.kind !== "msg") return false;
    return decodeInventory(f as Extract<Frame, { kind: "msg" }>) !== null;
  })) as Extract<Frame, { kind: "msg" }>;
  return decodeInventory(f)!;
}

// Unique-enough suffix that fits inside the server's 16-char username
// cap. `Date.now() % 10000` is plenty against parallel runs of the same
// spec; collisions resolve via ADR 0005 `base{N}` disambiguation, which
// would surface only as a one-character mismatch on `assigned_username`,
// not the inventory we care about here.
function uniq(prefix: string): string {
  const tail = (Date.now() % 10000).toString();
  const allowed = 16 - prefix.length - 1;
  return `${prefix}-${tail.slice(-Math.max(1, allowed))}`;
}

test("equip wire round-trip: EquipTool flips the equipped-slot pointer in InventoryUpdate", async () => {
  const username = uniq("equip-rt");
  const sock = await openSocket();
  await sendHello(sock.ws, username);

  // Initial inventory: the starter loadout plants every tool tier into
  // the panel but explicitly does NOT auto-equip (task 010 rework). The
  // player chooses which tier to equip; a fresh admit ships both
  // equipment pointers as `-1` so the wire surface and the
  // pre-task-010 break-rate timings stay aligned.
  const initial = await waitForInventory(sock);
  expect(initial.slots[WOOD_PICKAXE_SLOT].item).toBe(ITEM_ID_WOOD_PICKAXE);
  expect(initial.slots[WOOD_PICKAXE_SLOT].count).toBe(1);
  expect(initial.equippedPickaxeSlot).toBe(-1);
  expect(initial.equippedAxeSlot).toBe(-1);

  // Equip the wood pickaxe via the wire surface.
  await sendEquipTool(sock.ws, WOOD_PICKAXE_SLOT, TOOL_KIND_PICKAXE);

  // Next InventoryUpdate (next tick) carries the equipped-slot pointer;
  // the tool itself stayed in its inventory cell — equipment is a
  // flag, not a swap.
  const after = await waitForInventory(sock);
  expect(after.equippedPickaxeSlot).toBe(WOOD_PICKAXE_SLOT);
  expect(after.slots[WOOD_PICKAXE_SLOT].item).toBe(ITEM_ID_WOOD_PICKAXE);
  expect(after.slots[WOOD_PICKAXE_SLOT].count).toBe(1);

  sock.ws.close();
});

test("unequip wire round-trip: UnequipTool clears the equipped-slot pointer back to -1, tool stays in its cell", async () => {
  // Task 480: the symmetric un-equip gesture (left-click on a filled
  // equipment cell on the client) ships an `UnequipTool` frame; the next
  // `InventoryUpdate` carries the equipped pointer back to `-1`. The tool
  // itself stays put — equipment is a flag, not a swap (task 010 rework).
  const username = uniq("unequip-rt");
  const sock = await openSocket();
  await sendHello(sock.ws, username);
  // Initial admit: nothing equipped.
  const initial = await waitForInventory(sock);
  expect(initial.equippedPickaxeSlot).toBe(-1);

  // Equip first so there's something to unequip.
  await sendEquipTool(sock.ws, WOOD_PICKAXE_SLOT, TOOL_KIND_PICKAXE);
  const equipped = await waitForInventory(sock);
  expect(equipped.equippedPickaxeSlot).toBe(WOOD_PICKAXE_SLOT);
  expect(equipped.slots[WOOD_PICKAXE_SLOT].item).toBe(ITEM_ID_WOOD_PICKAXE);

  // Unequip. Next InventoryUpdate carries the cleared flag; the tool
  // stayed in its inventory cell.
  await sendUnequipTool(sock.ws, TOOL_KIND_PICKAXE);
  const after = await waitForInventory(sock);
  expect(after.equippedPickaxeSlot).toBe(-1);
  expect(after.slots[WOOD_PICKAXE_SLOT].item).toBe(ITEM_ID_WOOD_PICKAXE);
  expect(after.slots[WOOD_PICKAXE_SLOT].count).toBe(1);

  sock.ws.close();
});

test("equipped flag survives a reconnect (dormant record carries the slot pointer forward)", async () => {
  const username = uniq("equip-rec");

  // Session 1: connect (no auto-equip), explicitly equip the wood axe,
  // wait for the confirmation, then close so the server parks the
  // player into the dormant pool with the flag set.
  const session1 = await openSocket();
  await sendHello(session1.ws, username);
  const session1Inventory = await waitForInventory(session1);
  expect(session1Inventory.equippedAxeSlot).toBe(-1);

  await sendEquipTool(session1.ws, WOOD_AXE_SLOT, TOOL_KIND_AXE);
  const equipped = await waitForInventory(session1);
  expect(equipped.equippedAxeSlot).toBe(WOOD_AXE_SLOT);
  session1.ws.close();
  // Wait for the close to land server-side so end_session fires before the
  // reconnect Hello.
  await new Promise((r) => setTimeout(r, 200));

  // Session 2: reconnect under the same username. The dormant record
  // restored by the admission path must carry the equipped slot index
  // forward.
  const session2 = await openSocket();
  await sendHello(session2.ws, username, /* reconnect */ true);
  const restored = await waitForInventory(session2);
  expect(restored.equippedAxeSlot).toBe(WOOD_AXE_SLOT);
  expect(restored.slots[WOOD_AXE_SLOT].count).toBe(1);
  expect(restored.equippedPickaxeSlot).toBe(-1);
  session2.ws.close();
});
