import { test, expect, type Page } from "@playwright/test";

import { AdminItemId, adminGiveItem, adminTeleport } from "./admin";

// Task 010-tombstone e2e: anon disconnect spawns a tombstone block
// carrying the disconnecting player's full inventory. The grave is
// interactive: a second client can right-click it and pull the loot out
// just like a chest.
//
// Flow:
//   1. Open client A (anonymous "tomb-victim"). Teleport A to a known
//      spawn tile and stash a known stack of Stone in slot 0.
//   2. Disconnect A — anon, so the server should spawn a Tombstone at
//      A's last cell with A's inventory in the chunk's `chests` map.
//   3. Open client B (anonymous "tomb-looter"). Teleport B adjacent so
//      the tombstone is in reach.
//   4. Wait for the tick that loads chunk (0, 0) on B's view — the top
//      block at A's cell must read as Tombstone (BlockType variant 25).
//   5. Send `OpenChest` from B at A's cell. The server validates reach +
//      is-storage-block and emits a `ChestUpdate` carrying A's full
//      inventory.
//   6. Verify B's `chestState` mirrors the slot array with the Stone
//      stack in slot 0; move it into B's player grid and verify it
//      lands while the tombstone block itself stays (an emptied
//      tombstone is a normal block until broken).

const TOMB_TILE = { cx: 0, cy: 0, lx: 6, ly: 6 } as const;
const LOOTER_TILE = { cx: 0, cy: 0, lx: 5, ly: 6 } as const;
const BLOCK_TYPE_TOMBSTONE = 25;
const ITEM_ID_STONE = 3; // mirrors `AdminItemId.Stone` for use inside page.evaluate

async function openClient(page: Page, username: string): Promise<number> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      return id !== null && id !== 0 ? id : null;
    })
    .then((handle) => handle.jsonValue() as Promise<number>);
}

test("anon disconnect spawns a lootable tombstone for the next visitor", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();

  const aId = await openClient(a, "tomb-victim");

  // Park A on the tombstone tile so end_session lays the grave at a
  // predictable cell. Tile center is `(lx + 0.5, ly + 0.5)` in chunk
  // (0, 0) — feed the teleport that way.
  await adminTeleport(aId, TOMB_TILE.lx + 0.5, TOMB_TILE.ly + 0.5);
  await a.waitForFunction(
    ({ id, lx, ly }) => {
      const handle = window.__anarchy;
      if (!handle) return false;
      const me = handle.world.getPlayer(id);
      if (!me) return false;
      return Math.floor(me.x) === lx && Math.floor(me.y) === ly;
    },
    { id: aId, lx: TOMB_TILE.lx, ly: TOMB_TILE.ly },
  );

  // Stash a known stack — Stone in the first hotbar slot.
  await adminGiveItem(aId, AdminItemId.Stone, 5);
  await a.waitForFunction(
    (item) => window.__anarchy!.inventory.countOf(item) === 5,
    ITEM_ID_STONE,
  );

  // Disconnect A. `stop()` tears down the socket; the server's per-conn
  // close handler calls `end_session` which (anon) spawns the tombstone.
  await a.evaluate(async () => {
    const h = window.__anarchy!;
    h.stop();
    await h.stopped;
  });
  await ctxA.close();

  // Open looter B and walk them up to the tombstone cell.
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  try {
    const bId = await openClient(b, "tomb-looter");
    await adminTeleport(bId, LOOTER_TILE.lx + 0.5, LOOTER_TILE.ly + 0.5);

    // Wait for the tombstone block to land in B's terrain mirror.
    await b.waitForFunction(
      ({ cx, cy, lx, ly, kind }) => {
        const handle = window.__anarchy;
        if (!handle) return false;
        const chunk = handle.terrain.get(cx, cy);
        if (!chunk) return false;
        const block = chunk.top.blocks[ly * 16 + lx];
        return block?.kind === kind;
      },
      { ...TOMB_TILE, kind: BLOCK_TYPE_TOMBSTONE },
      { timeout: 15_000 },
    );

    // Right-click open — send the wire frame directly so the spec stays
    // independent of cursor / camera plumbing.
    await b.evaluate((tile) => {
      window.__anarchy!.sendOpenChest(tile.cx, tile.cy, tile.lx, tile.ly);
    }, TOMB_TILE);

    // The next tick's `ChestUpdate` lands; chest mirror picks it up.
    await b.waitForFunction(
      ({ tile, item }) => {
        const handle = window.__anarchy;
        if (!handle) return false;
        const inv = handle.chestState.inventoryFor(tile);
        if (inv === null) return false;
        const slot = inv.slot(0);
        return slot !== null && slot.item === item && slot.count === 5;
      },
      { tile: TOMB_TILE, item: ITEM_ID_STONE },
      { timeout: 15_000 },
    );

    // Move slot 0 of the tombstone into slot 0 of B's player inventory.
    // The server applies the cross-grid move; the next tick clears the
    // tombstone slot and B's slot 0 carries the stack.
    await b.evaluate((tile) => {
      window.__anarchy!.sendMoveSlot(0, 0, tile, null);
    }, TOMB_TILE);

    await b.waitForFunction(
      ({ tile, item }) => {
        const handle = window.__anarchy;
        if (!handle) return false;
        const tombInv = handle.chestState.inventoryFor(tile);
        if (tombInv === null) return false;
        return tombInv.slot(0) === null && handle.inventory.countOf(item) === 5;
      },
      { tile: TOMB_TILE, item: ITEM_ID_STONE },
      { timeout: 15_000 },
    );

    // Sanity: the tombstone block stays in place even when emptied —
    // task 010-tombstone notes "empty tombstone stays as a block until
    // broken".
    const stillThere = await b.evaluate((tile) => {
      const chunk = window.__anarchy!.terrain.get(tile.cx, tile.cy);
      const block = chunk?.top.blocks[tile.ly * 16 + tile.lx];
      return block?.kind ?? null;
    }, TOMB_TILE);
    expect(stillThere).toBe(BLOCK_TYPE_TOMBSTONE);
  } finally {
    await ctxB.close();
  }
});
