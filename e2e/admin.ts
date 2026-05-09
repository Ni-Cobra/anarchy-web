// Task 110: thin TS shims around the testing-mode admin endpoints exposed
// by the server (`anarchy-server/src/network/debug.rs`). Specs that need
// to plant authoritative state without simulating it through the wire
// (block placements, inventory items, player position) hit these helpers
// instead of reproducing the fetch calls inline.
//
// The endpoints are gated to testing mode server-side (404 outside), so
// these helpers will throw if the server was started without `--testing`.
// Playwright's webServer config in `playwright.config.ts` always passes
// `--testing` for the shared 8080 server.
//
// Numeric `ItemId` mirrors `proto::v1::ItemId` (see
// `anarchy-server/src/network/debug.rs::item_id_from_wire`).

const SERVER_URL = "http://localhost:8080";

export type AdminBlockKind =
  | "air"
  | "grass"
  | "wood"
  | "stone"
  | "gold"
  | "tree"
  | "sticks";

export type AdminBlockLayer = "top" | "ground";

/** Numeric `ItemId` wire values; mirror of the proto `ItemId` enum. */
export const AdminItemId = {
  Stick: 1,
  Wood: 2,
  Stone: 3,
  Gold: 4,
  WoodPickaxe: 5,
  StonePickaxe: 6,
  CopperPickaxe: 7,
  IronPickaxe: 8,
  TungstenPickaxe: 9,
  WoodAxe: 10,
  StoneAxe: 11,
  CopperAxe: 12,
  IronAxe: 13,
  TungstenAxe: 14,
} as const;

export type AdminItemId = (typeof AdminItemId)[keyof typeof AdminItemId];

async function postOk(url: string): Promise<void> {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    throw new Error(`admin call failed: POST ${url} → ${r.status} ${r.statusText}`);
  }
}

/**
 * Drop `count` items of `item` (numeric `ItemId`) into the player's
 * inventory via `try_add` and flip the dirty bit so the next tick ships a
 * fresh `InventoryUpdate`. Counts > 255 are clamped server-side.
 */
export async function adminGiveItem(
  playerId: number,
  item: AdminItemId,
  count: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/give-item/${playerId}/${item}/${count}`);
}

/**
 * Set chunk `(cx, cy)` cell `(lx, ly)` on the named layer to `kind`. The
 * destination chunk is generated on demand if it isn't already loaded.
 */
export async function adminSetBlock(
  cx: number,
  cy: number,
  layer: AdminBlockLayer,
  lx: number,
  ly: number,
  kind: AdminBlockKind,
): Promise<void> {
  await postOk(
    `${SERVER_URL}/admin/set-block/${cx}/${cy}/${layer}/${lx}/${ly}/${kind}`,
  );
}

/**
 * Move player `id` to world coords `(x, y)` and zero their velocity. The
 * destination chunk is generated on demand if it isn't already loaded.
 */
export async function adminTeleport(
  playerId: number,
  x: number,
  y: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/teleport-player/${playerId}/${x}/${y}`);
}
