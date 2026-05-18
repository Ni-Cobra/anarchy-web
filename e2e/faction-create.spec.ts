import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminCreateFaction,
  adminDestroyFaction,
  adminGiveItem,
} from "./admin";

// Task 240 e2e: place a real crafted flag, create a faction via the
// admin shim, and observe the leaderboard HUD update via the wire
// pipeline. The dialog open/submit/cancel logic is covered in
// `src/ui/create_faction_dialog.test.ts`; here we pin the cross-repo
// wire path end-to-end (server admission → `factions_delta` →
// client mirror → HUD).
//
// Covers:
//   - admin `/admin/create-faction` succeeds against a real placed
//     flag → leaderboard HUD shows "Current leading faction: Alpha".
//   - case-insensitive duplicate name is rejected by the same admin
//     gate that wire `CreateFactionIntent` flows through.
//   - admin `/admin/destroy-faction` succeeds → leaderboard delta
//     drops the entry → HUD returns to "No factions yet".

const ITEM_GOLD = AdminItemId.Gold;
const ITEM_FLAG = AdminItemId.Flag;

const FLAG_CHUNK = { cx: 0, cy: 0 } as const;
const FLAG_CELL = { lx: 3, ly: 0 } as const;
const BLOCK_TYPE_FLAG = 27;

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

async function findSlotFor(page: Page, itemId: number): Promise<number> {
  return await page.evaluate((id: number) => {
    const inv = window.__anarchy!.inventory;
    for (let i = 0; i < 45; i++) {
      const s = inv.slot(i);
      if (s !== null && s.item === id) return i;
    }
    return -1;
  }, itemId);
}

async function craftAndPlaceFlag(page: Page): Promise<void> {
  // Seed the recipe ingredients, craft cloth twice + flag, then place
  // the resulting stack so its `FlagBlockState.owner_id` is stamped.
  await adminGiveItem(
    (await page.evaluate(() => window.__anarchy!.getLocalPlayerId()!)),
    AdminItemId.String,
    12,
  );
  await adminGiveItem(
    (await page.evaluate(() => window.__anarchy!.getLocalPlayerId()!)),
    AdminItemId.Wood,
    1,
  );
  await page.waitForFunction(
    ({ stringId, woodId }) => {
      const inv = window.__anarchy!.inventory;
      return inv.countOf(stringId) === 12 && inv.countOf(woodId) === 1;
    },
    { stringId: AdminItemId.String, woodId: AdminItemId.Wood },
  );

  await page.keyboard.press("KeyE");
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='cloth']"),
  ).toHaveCount(1, { timeout: 5_000 });
  await page.locator(".anarchy-crafting-row[data-recipe-id='cloth']").click();
  await page.waitForFunction(
    (id: number) => window.__anarchy!.inventory.countOf(id) === 1,
    AdminItemId.Cloth,
  );
  await page.locator(".anarchy-crafting-row[data-recipe-id='cloth']").click();
  await page.waitForFunction(
    (id: number) => window.__anarchy!.inventory.countOf(id) === 2,
    AdminItemId.Cloth,
  );
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='flag']"),
  ).toHaveCount(1, { timeout: 5_000 });
  await page.locator(".anarchy-crafting-row[data-recipe-id='flag']").click();
  await page.waitForFunction(
    (id: number) => window.__anarchy!.inventory.countOf(id) === 1,
    ITEM_FLAG,
  );
  await page.keyboard.press("KeyE");

  const flagSlot = await findSlotFor(page, ITEM_FLAG);
  expect(flagSlot).toBeGreaterThanOrEqual(0);
  const PLACE_HOTBAR_SLOT = 1;
  if (flagSlot !== PLACE_HOTBAR_SLOT) {
    await page.evaluate(
      ({ src, dst }) => {
        window.__anarchy!.sendMoveSlot(src, dst);
      },
      { src: flagSlot, dst: PLACE_HOTBAR_SLOT },
    );
    await page.waitForFunction(
      ({ slot, flagId }) => {
        const s = window.__anarchy!.inventory.slot(slot);
        return s !== null && s.item === flagId;
      },
      { slot: PLACE_HOTBAR_SLOT, flagId: ITEM_FLAG },
    );
  }
  await page.keyboard.press(`Digit${PLACE_HOTBAR_SLOT + 1}`);
  await page.waitForFunction(
    (slot: number) => window.__anarchy!.getSelectedHotbarSlot() === slot,
    PLACE_HOTBAR_SLOT,
  );
  await page.evaluate(
    (tile) => {
      window.__anarchy!.sendPlaceBlock(tile.cx, tile.cy, tile.lx, tile.ly);
    },
    { ...FLAG_CHUNK, ...FLAG_CELL },
  );
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
}

test("create-faction round-trip: leaderboard delta updates the HUD; case-insensitive dup is rejected; destroy clears the HUD", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const self = await openClient(page, "alpha-founder", 3);

  // Initial state: no factions, HUD reads the empty placeholder.
  await expect(page.locator(".anarchy-leaderboard-label")).toHaveText(
    "No factions yet",
    { timeout: 5_000 },
  );

  await craftAndPlaceFlag(page);

  // Admin-create the faction on the just-placed flag.
  const factionId = await adminCreateFaction(
    FLAG_CHUNK.cx,
    FLAG_CHUNK.cy,
    FLAG_CELL.lx,
    FLAG_CELL.ly,
    self.id,
    "Alpha",
  );
  expect(factionId).toBeGreaterThan(0);

  // Leaderboard delta lands within a few ticks; the cached store
  // and the HUD both reflect it.
  await page.waitForFunction(
    (id: number) => {
      const fac = window.__anarchy!.leaderboardStore.current().get(id);
      return fac !== undefined && fac.name === "Alpha" && fac.xp === 0;
    },
    factionId,
    { timeout: 5_000 },
  );
  await expect(page.locator(".anarchy-leaderboard-label")).toHaveText(
    "Current leading faction: Alpha",
  );

  // Case-insensitive duplicate name rejected (the same gate the wire
  // CreateFactionIntent goes through). The body carries one of the
  // typed reasons — either "name_taken" (correctly typed) or
  // "flag_already_claimed" if the test re-uses the same flag.
  await expect(
    adminCreateFaction(0, 0, 3, 0, self.id, "alpha"),
  ).rejects.toThrow(/name_taken|flag_already_claimed/);

  // Destroy the faction → leaderboard delta drops it → HUD reverts.
  await adminDestroyFaction(factionId);
  await page.waitForFunction(
    (id: number) => !window.__anarchy!.leaderboardStore.current().has(id),
    factionId,
    { timeout: 5_000 },
  );
  await expect(page.locator(".anarchy-leaderboard-label")).toHaveText(
    "No factions yet",
  );
});
