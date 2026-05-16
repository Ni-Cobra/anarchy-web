import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminAttackPlayer,
  adminGiveItem,
  adminTeleport,
} from "./admin";

// Task 110 e2e: a charging attacker is locked immobile for the 0.7 s
// charge window, and the bumped range gate (4 → 6 tiles) admits a
// previously-rejected target sitting at 5.5 tiles.

const CHARGE_MS = 700;
const RESOLUTION_PAD_MS = 800;

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page, username: string): Promise<SelfView> {
  await page.goto(`/?username=${username}&color=0`);
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

async function adminGrantAndEquipSword(
  page: Page,
  playerId: number,
  itemId: number,
): Promise<void> {
  await adminGiveItem(playerId, itemId as 44, 1);
  await page.waitForFunction(
    (id: number) => window.__anarchy!.inventory.countOf(id) === 1,
    itemId,
  );
  const slot = await page.evaluate((id: number) => {
    const inv = window.__anarchy!.inventory;
    for (let i = 0; i < 45; i++) {
      const s = inv.slot(i);
      if (s !== null && s.item === id) return i;
    }
    return -1;
  }, itemId);
  if (slot < 0) {
    throw new Error(`sword item ${itemId} not found in inventory after grant`);
  }
  await page.evaluate(
    (s: number) => window.__anarchy!.sendEquipTool(s, "sword"),
    slot,
  );
  await page.waitForFunction(
    () => window.__anarchy!.inventory.getEquippedSlot("sword") !== null,
  );
}

async function readSelfPos(page: Page): Promise<{ x: number; y: number }> {
  return await page.evaluate(() => {
    const a = window.__anarchy!;
    const id = a.getLocalPlayerId()!;
    const me = a.world.getPlayer(id)!;
    return { x: me.x, y: me.y };
  });
}

test("attacker locked during 0.7s charge, then walks freely after resolve", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "atk-lock-a");
    const meB = await openClient(b, "atk-lock-b");
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);
    await adminGrantAndEquipSword(a, meA.id, AdminItemId.WoodSword);

    // Wait for A's view of its own position to settle at the teleport.
    await a.waitForFunction(() => {
      const ax = window.__anarchy!.world.getPlayer(
        window.__anarchy!.getLocalPlayerId()!,
      )?.x;
      return ax !== undefined && Math.abs(ax - 0.5) < 0.05;
    });
    const startA = await readSelfPos(a);

    // Kick off the charge then immediately try to drive A east. Under
    // task 110 the server zeroes velocity every tick the attacker is
    // `Charging`, so the held intent never produces translation.
    await adminAttackPlayer(meA.id, meB.id);
    await a.evaluate(() => window.__anarchy!.sendMoveIntent(1, 0));
    // Sample at ~mid-charge to confirm no drift.
    await new Promise((r) => setTimeout(r, 350));
    const midA = await readSelfPos(a);
    expect(Math.abs(midA.x - startA.x)).toBeLessThan(0.1);
    expect(Math.abs(midA.y - startA.y)).toBeLessThan(0.1);

    // Wait through the strike resolution.
    await b.waitForFunction(
      () => {
        const a = window.__anarchy!;
        const id = a.getLocalPlayerId();
        if (id === null) return false;
        return a.world.getPlayer(id)?.health === 85;
      },
      undefined,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );

    // After the strike: A teleported adjacent to B (dash-on-hit) and is
    // now in Cooldown. Hold intent east; the cooldown does NOT restrict
    // motion, so A must keep moving.
    await a.evaluate(() => window.__anarchy!.sendMoveIntent(1, 0));
    const afterResolve = await readSelfPos(a);
    await new Promise((r) => setTimeout(r, 500));
    const afterWalk = await readSelfPos(a);
    expect(afterWalk.x).toBeGreaterThan(afterResolve.x + 0.3);
    await a.evaluate(() => window.__anarchy!.sendMoveIntent(0, 0));
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("range bump admits a wood-sword strike at 5.5 tiles", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "atk-range-a");
    const meB = await openClient(b, "atk-range-b");
    // 5.5 tiles apart along x — under the pre-task-110 4-tile gate this
    // would have rejected admission. Task 110 bumped both gates to 6.
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 6.0, 0.5);
    await adminGrantAndEquipSword(a, meA.id, AdminItemId.WoodSword);
    await a.waitForFunction(
      (id: number) => window.__anarchy!.world.getPlayer(id)?.health === 100,
      meB.id,
    );

    await adminAttackPlayer(meA.id, meB.id);
    // Wood sword = 15 dmg → B drops 100 → 85 once the charge resolves.
    await b.waitForFunction(
      () => {
        const a = window.__anarchy!;
        const id = a.getLocalPlayerId();
        if (id === null) return false;
        return a.world.getPlayer(id)?.health === 85;
      },
      undefined,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
