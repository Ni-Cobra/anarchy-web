import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminEquipTool,
  adminFireBlowgun,
  adminGiveItem,
  adminTeleport,
} from "./admin";

// Task 200b e2e: server-side blowgun-projectile pipeline driven through
// the admin endpoints. Covers the admin-driven scenarios pinned by the
// task brief:
//   1. Hit — admin-fire at a stationary target 5 tiles away; within
//      ~1 s B's HP drops by 1 and A's PoisonDart count drops by 1.
//   2. Cooldown — a second immediate /admin/fire-blowgun returns 400
//      (server rejects with `on_cooldown`); no second dart is consumed.
//
// The real right-click + the 5 user-facing scenarios (HP, slow, dart
// count, no-place, cooldown, spider target, out-of-range) land in
// 200c. The wire path here (admin → `World::spawn_poison_dart` →
// `tick_projectiles` impact) is exactly the same one the wire
// `FireBlowgunIntent` will take.

const SERVER_URL = "http://localhost:8080";

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page, username: string): Promise<SelfView> {
  await page.goto(`/?username=${encodeURIComponent(username)}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
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

async function readRemoteHp(page: Page, id: number): Promise<number | null> {
  return await page.evaluate((pid: number) => {
    const p = window.__anarchy!.world.getPlayer(pid);
    return p ? p.health : null;
  }, id);
}

/** Find the inventory slot index holding `itemId`, or `-1` if absent. */
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

/**
 * Wait until the local player's inventory mirror reports `count` of
 * `itemId` (or more). The mirror lags the server by one tick; this
 * helper synchronises so subsequent admin actions read a consistent
 * inventory state.
 */
async function waitForItemCount(
  page: Page,
  itemId: number,
  count: number,
): Promise<void> {
  await page.waitForFunction(
    ([id, n]: [number, number]) =>
      window.__anarchy!.inventory.countOf(id) >= n,
    [itemId, count] as const,
  );
}

async function setupAttackerWithBlowgun(
  page: Page,
  playerId: number,
): Promise<void> {
  await adminGiveItem(playerId, AdminItemId.Blowgun, 1);
  await adminGiveItem(playerId, AdminItemId.PoisonDart, 4);
  await waitForItemCount(page, AdminItemId.Blowgun, 1);
  await waitForItemCount(page, AdminItemId.PoisonDart, 4);
  const blowgunSlot = await findSlotFor(page, AdminItemId.Blowgun);
  expect(blowgunSlot).toBeGreaterThanOrEqual(0);
  await adminEquipTool(playerId, "utility", blowgunSlot);
  await page.waitForFunction(
    () => window.__anarchy!.inventory.getEquippedSlot("utility") !== null,
  );
}

test("admin-driven blowgun hit drops 1 HP and consumes 1 dart", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    const selfA = await openClient(a, "blowA");
    const selfB = await openClient(b, "blowB");

    // Pin both players to known cells, 5 tiles apart on the x axis —
    // well within BLOWGUN_RANGE_TILES = 8.
    await adminTeleport(selfA.id, 0.5, 0.5);
    await adminTeleport(selfB.id, 5.5, 0.5);
    await a.waitForFunction((id: number) => {
      const me = window.__anarchy!.world.getPlayer(id);
      return me !== null && Math.abs(me.x - 0.5) < 0.1 && Math.abs(me.y - 0.5) < 0.1;
    }, selfA.id);
    await b.waitForFunction((id: number) => {
      const me = window.__anarchy!.world.getPlayer(id);
      return me !== null && Math.abs(me.x - 5.5) < 0.1 && Math.abs(me.y - 0.5) < 0.1;
    }, selfB.id);

    await setupAttackerWithBlowgun(a, selfA.id);

    const initialHp = await readRemoteHp(b, selfB.id);
    expect(initialHp).not.toBeNull();

    await adminFireBlowgun(selfA.id, "player", selfB.id);

    // Within ~1s the dart should have impacted; B's HP drops by 1.
    await b.waitForFunction(
      ([pid, hpBefore]: [number, number]) => {
        const me = window.__anarchy!.world.getPlayer(pid);
        return me !== null && me.health < hpBefore;
      },
      [selfB.id, initialHp as number] as const,
      { timeout: 5000 },
    );
    const hpAfter = await readRemoteHp(b, selfB.id);
    expect(hpAfter).toBe((initialHp as number) - 1);

    // A's dart count dropped by 1 — was 4, now 3.
    await a.waitForFunction(
      (dartId: number) => window.__anarchy!.inventory.countOf(dartId) === 3,
      AdminItemId.PoisonDart,
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("admin cooldown gate rejects a second fire inside 1s", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    const selfA = await openClient(a, "blowC");
    const selfB = await openClient(b, "blowD");

    await adminTeleport(selfA.id, 0.5, 0.5);
    await adminTeleport(selfB.id, 5.5, 0.5);
    await a.waitForFunction((id: number) => {
      const me = window.__anarchy!.world.getPlayer(id);
      return me !== null && Math.abs(me.x - 0.5) < 0.1;
    }, selfA.id);

    await setupAttackerWithBlowgun(a, selfA.id);

    // First fire admits.
    await adminFireBlowgun(selfA.id, "player", selfB.id);

    // Second fire immediately — server rejects with 400. Don't use
    // the admin helper (which throws on non-2xx); call fetch directly
    // so we can inspect status + body.
    const r = await fetch(
      `${SERVER_URL}/admin/fire-blowgun/${selfA.id}/player/${selfB.id}`,
      { method: "POST" },
    );
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain("on_cooldown");

    // Only one dart was consumed.
    await a.waitForFunction(
      (dartId: number) => window.__anarchy!.inventory.countOf(dartId) === 3,
      AdminItemId.PoisonDart,
    );
    await a.waitForTimeout(200);
    const finalDarts = await a.evaluate(
      (dartId: number) => window.__anarchy!.inventory.countOf(dartId),
      AdminItemId.PoisonDart,
    );
    expect(finalDarts).toBe(3);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
