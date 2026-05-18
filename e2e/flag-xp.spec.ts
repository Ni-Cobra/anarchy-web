import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminCreateFaction,
  adminFlagInteract,
  adminFlagInteractRelease,
  adminGrantXp,
  adminPlaceFlag,
  adminTeleport,
} from "./admin";

// Task 250 e2e: flag XP transfer (deposit + steal) + drain-to-destroy.
// Server-side admin shims drive the wire path that
// `World::apply_flag_interact_intent` / `World::tick_flag_transfers`
// validate; the client mirror is exercised through the
// `leaderboardStore` (factions delta fan-out) and per-player
// snapshot mirror (player xp updates).

const FLAG_CHUNK = { cx: 0, cy: 0 } as const;
const FLAG_CELL = { lx: 3, ly: 0 } as const;
const BLOCK_TYPE_FLAG = 27;
const ITEM_GOLD = AdminItemId.Gold;

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(
  page: Page,
  username: string,
  color: number,
): Promise<SelfView> {
  await page.goto(`/?username=${username}&color=${color}`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  await page.waitForFunction((goldId: number) => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(goldId) === 10;
  }, ITEM_GOLD);
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      if (id === null || id === 0) return null;
      const me = a.world.getPlayer(id);
      if (!me) return null;
      return { id: me.id, x: me.x, y: me.y };
    })
    .then((h) => h.jsonValue() as Promise<SelfView>);
}

async function setupFlagAndFaction(
  page: Page,
  playerId: number,
  factionName: string,
  color: number,
): Promise<number> {
  await adminPlaceFlag(
    playerId,
    FLAG_CHUNK.cx,
    FLAG_CHUNK.cy,
    FLAG_CELL.lx,
    FLAG_CELL.ly,
    color,
  );
  // Confirm the flag landed on the client mirror.
  await page.waitForFunction(
    (tile) => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(tile.cx, tile.cy);
      if (!chunk) return false;
      const idx = tile.ly * 16 + tile.lx;
      return chunk.top.blocks[idx]?.kind === tile.expectedKind;
    },
    { ...FLAG_CHUNK, ...FLAG_CELL, expectedKind: BLOCK_TYPE_FLAG },
    { timeout: 5_000 },
  );
  const factionId = await adminCreateFaction(
    FLAG_CHUNK.cx,
    FLAG_CHUNK.cy,
    FLAG_CELL.lx,
    FLAG_CELL.ly,
    playerId,
    factionName,
  );
  expect(factionId).toBeGreaterThan(0);
  // Wait for the leaderboard mirror to pick up the new faction.
  await page.waitForFunction(
    (id: number) => window.__anarchy!.leaderboardStore.current().has(id),
    factionId,
    { timeout: 5_000 },
  );
  return factionId;
}

test("flag XP deposit moves player → faction, and faction xp surfaces in the leaderboard mirror", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const self = await openClient(page, "depositor", 3);
  const factionId = await setupFlagAndFaction(page, self.id, "Alpha", 3);
  await adminGrantXp(self.id, 20);
  await page.waitForFunction(
    (pid: number) => {
      const me = window.__anarchy!.world.getPlayer(pid);
      return me !== null && me.xp >= 20;
    },
    self.id,
  );
  // Position the player in range of the flag (flag center is (3.5, 0.5);
  // (1.5, 0.5) is 2 tiles away — under FLAG_INTERACT_RANGE_TILES = 4).
  await adminTeleport(self.id, 1.5, 0.5);
  await page.waitForFunction(
    (pid: number) => {
      const me = window.__anarchy!.world.getPlayer(pid);
      return me !== null && Math.abs(me.x - 1.5) < 0.1;
    },
    self.id,
  );
  await adminFlagInteract(
    self.id,
    FLAG_CHUNK.cx,
    FLAG_CHUNK.cy,
    FLAG_CELL.lx,
    FLAG_CELL.ly,
    "deposit",
  );
  // The full 20 XP transfer takes 2 s at 10/s; wait up to 8 s for the
  // delta to land in both the player snapshot and the faction mirror.
  await page.waitForFunction(
    (id: number) => {
      const fac = window.__anarchy!.leaderboardStore.current().get(id);
      return fac !== undefined && fac.xp >= 20;
    },
    factionId,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    (pid: number) => {
      const me = window.__anarchy!.world.getPlayer(pid);
      return me !== null && me.xp === 0;
    },
    self.id,
    { timeout: 10_000 },
  );
  await adminFlagInteractRelease(self.id);
  // Flag still stands while drained=false on the server-side, so the
  // client mirror should still show the Flag cell.
  const flagStillStands = await page.evaluate(
    (tile) => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(tile.cx, tile.cy);
      if (!chunk) return false;
      const idx = tile.ly * 16 + tile.lx;
      return chunk.top.blocks[idx]?.kind === tile.expectedKind;
    },
    { ...FLAG_CHUNK, ...FLAG_CELL, expectedKind: BLOCK_TYPE_FLAG },
  );
  expect(flagStillStands).toBe(true);
});

test("flag XP steal moves faction → player and zeroes the faction xp", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const self = await openClient(page, "stealer", 5);
  const factionId = await setupFlagAndFaction(page, self.id, "Beta", 5);
  // Plant XP on the faction by first depositing.
  await adminGrantXp(self.id, 15);
  await adminTeleport(self.id, 1.5, 0.5);
  await page.waitForFunction(
    (pid: number) => {
      const me = window.__anarchy!.world.getPlayer(pid);
      return me !== null && me.xp === 15 && Math.abs(me.x - 1.5) < 0.1;
    },
    self.id,
  );
  await adminFlagInteract(
    self.id,
    FLAG_CHUNK.cx,
    FLAG_CHUNK.cy,
    FLAG_CELL.lx,
    FLAG_CELL.ly,
    "deposit",
  );
  await page.waitForFunction(
    (id: number) => {
      const fac = window.__anarchy!.leaderboardStore.current().get(id);
      return fac !== undefined && fac.xp >= 15;
    },
    factionId,
    { timeout: 10_000 },
  );
  await adminFlagInteractRelease(self.id);
  // Brief pause so the release hits the next tick before the steal
  // intent overwrites it.
  await page.waitForTimeout(100);
  await adminFlagInteract(
    self.id,
    FLAG_CHUNK.cx,
    FLAG_CHUNK.cy,
    FLAG_CELL.lx,
    FLAG_CELL.ly,
    "steal",
  );
  await page.waitForFunction(
    (id: number) => {
      const fac = window.__anarchy!.leaderboardStore.current().get(id);
      return fac !== undefined && fac.xp === 0;
    },
    factionId,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    (pid: number) => {
      const me = window.__anarchy!.world.getPlayer(pid);
      return me !== null && me.xp === 15;
    },
    self.id,
    { timeout: 10_000 },
  );
  await adminFlagInteractRelease(self.id);
});
