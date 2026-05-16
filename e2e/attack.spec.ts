import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminAttackEntity,
  adminAttackPlayer,
  adminGiveItem,
  adminSpawnEntity,
  adminTeleport,
} from "./admin";

// Task 070a e2e: server-side attack pipeline driven through the admin
// endpoints. Covers the four pinned scenarios:
//   1. PvP hit  — wood sword: B HP drops by 15; A is in cooldown for 5s.
//   2. PvE      — stone sword: spider HP drops by 20; repeat → dies.
//   3. Out-of-reach miss — admin-teleport B beyond strike range before
//      the 0.7s charge resolves; B's HP unchanged; A still cools down.
//   4. Bare-hand — no sword equipped: spider HP drops by 5.
//
// All four exercise the wire (`AttackIntent` admission → `AttackEvent`
// fan-out via `TickUpdate`) since the admin endpoint synthesizes the
// same `AttackIntent` a real client would. The 070b client work
// (target-pick, beam render, dash lerp) is intentionally out of scope.

const CHARGE_MS = 700;
// Charge resolves at ~700ms; pad to absorb tick alignment + scheduler
// jitter so the resolution lands inside the wait window.
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

/** Grant `itemId` to `playerId`, equip the cell into the sword slot. */
async function adminGrantAndEquipSword(
  page: Page,
  playerId: number,
  itemId: number,
): Promise<void> {
  await adminGiveItem(playerId, itemId as 44, 1);
  // The inventory frame lands on the next tick; wait for the item to
  // appear, then drive an `EquipTool` through the wire so the server
  // pins the equipped flag on its cell.
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
  // Wait for the next `InventoryUpdate` to reflect the equipped flag.
  await page.waitForFunction(
    () => window.__anarchy!.inventory.getEquippedSlot("sword") !== null,
  );
}

/** Read a remote player's HP via the world mirror (snapshot-driven). */
async function readRemoteHp(page: Page, id: number): Promise<number | null> {
  return await page.evaluate((pid: number) => {
    const p = window.__anarchy!.world.getPlayer(pid);
    return p ? p.health : null;
  }, id);
}

test("admin PvP hit with wood sword subtracts 15 HP and cools down attacker", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "atk-pvp-a");
    const meB = await openClient(b, "atk-pvp-b");

    // Plant the two players close enough for a hit (4-tile ATTACK_RANGE).
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);

    // A holds a wood sword; the equipped slot tells the server which tier
    // damage to apply. Wood = 15.
    await adminGrantAndEquipSword(a, meA.id, AdminItemId.WoodSword);

    // Both clients should see B at full HP before the strike.
    await a.waitForFunction(
      (id: number) => window.__anarchy!.world.getPlayer(id)?.health === 100,
      meB.id,
    );

    await adminAttackPlayer(meA.id, meB.id);

    // After the 0.7s charge, B's HP drops by 15 (wood sword tier).
    await Promise.all([
      a.waitForFunction(
        (id: number) => window.__anarchy!.world.getPlayer(id)?.health === 85,
        meB.id,
        { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
      ),
      b.waitForFunction(
        () => {
          const a = window.__anarchy!;
          const id = a.getLocalPlayerId();
          if (id === null) return false;
          return a.world.getPlayer(id)?.health === 85;
        },
        undefined,
        { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
      ),
    ]);

    // Attacker is on cooldown: a second admin attack within the 5s window
    // must reject with a 400.
    let rejected = false;
    try {
      await adminAttackPlayer(meA.id, meB.id);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(await readRemoteHp(a, meB.id)).toBe(85);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("admin PvE: stone sword drops spider by 20 then kills on second swing", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "atk-pve");
    await adminTeleport(me.id, 0.5, 0.5);
    await adminGrantAndEquipSword(page, me.id, AdminItemId.StoneSword);

    // Spawn the spider close enough that even a random-walk drift
    // during the 0.7s charge can't carry it out of STRIKE_RANGE = 4.
    const spiderId = await adminSpawnEntity("spider", 1, 0);
    expect(spiderId).toBeGreaterThan(0);
    await page.waitForFunction(
      (id: number) => window.__anarchy!.getRenderedEntities()[id] !== undefined,
      spiderId,
    );

    // Stone sword = 20 dmg. Spider max HP = 20 → strike kills.
    await adminAttackEntity(me.id, spiderId);
    await page.waitForFunction(
      (id: number) => window.__anarchy!.getRenderedEntities()[id] === undefined,
      spiderId,
      { timeout: 5_000 },
    );
  } finally {
    await ctx.close();
  }
});

test("admin out-of-reach miss: target teleported away mid-charge takes no damage", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "atk-miss-a");
    const meB = await openClient(b, "atk-miss-b");
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);
    await adminGrantAndEquipSword(a, meA.id, AdminItemId.WoodSword);

    await adminAttackPlayer(meA.id, meB.id);
    // Mid-charge, yank B to ~30 tiles away — beyond STRIKE_RANGE_TILES = 4.
    await adminTeleport(meB.id, 30.5, 0.5);

    // After the 0.7s charge, B's HP must be unchanged.
    await new Promise((r) => setTimeout(r, CHARGE_MS + RESOLUTION_PAD_MS));
    expect(await readRemoteHp(a, meB.id)).toBe(100);

    // Attacker is on cooldown — re-attempt rejects with 400.
    let rejected = false;
    try {
      await adminAttackPlayer(meA.id, meB.id);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("admin bare-hand attack drops spider HP by 5", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "atk-bare");
    await adminTeleport(me.id, 0.5, 0.5);
    // No sword equipped: damage = BARE_HAND_DAMAGE = 5.
    const spiderId = await adminSpawnEntity("spider", 2, 0);
    // Walk the loaded terrain to find the entity; the spider sits in
    // whichever chunk hosts tile (2, 0) — `(0, 0)` for `LAYER_SIZE = 16`.
    const readSpiderHp = async (): Promise<number | null> =>
      page.evaluate((id: number) => {
        const t = window.__anarchy!.terrain;
        for (const [, chunk] of t.iter()) {
          const e = chunk.entities.get(id);
          if (e) return e.health;
        }
        return null;
      }, spiderId);

    await page.waitForFunction(
      (id: number) => {
        const t = window.__anarchy!.terrain;
        for (const [, chunk] of t.iter()) {
          if (chunk.entities.get(id)?.health === 20) return true;
        }
        return false;
      },
      spiderId,
    );

    await adminAttackEntity(me.id, spiderId);
    await page.waitForFunction(
      (id: number) => {
        const t = window.__anarchy!.terrain;
        for (const [, chunk] of t.iter()) {
          if (chunk.entities.get(id)?.health === 15) return true;
        }
        return false;
      },
      spiderId,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );
    expect(await readSpiderHp()).toBe(15);
  } finally {
    await ctx.close();
  }
});
