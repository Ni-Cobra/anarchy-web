import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminEquipTool,
  adminGiveItem,
  adminSetBlock,
  adminSpawnEntity,
  adminTeleport,
} from "./admin";

// Task 200c e2e: real-click blowgun pipeline driven through the page's
// mousedown event. The admin-driven server pipeline is already pinned by
// `blowgun-admin.spec.ts`; this spec exercises the client half — right-
// click → `FireBlowgunIntent` → projectile snapshot → impact → slow
// indicator → dart count.

const CHARGE_MS = 1500; // dart travel + impact at 10 tiles/sec over up to ~8 tiles
const DEFAULT_VIEW_W = 1280;
const DEFAULT_VIEW_H = 720;
const CAMERA_HEIGHT = 14;
const CAMERA_HALF_FOV_TAN = Math.tan((30 * Math.PI) / 180);
const SLOW_DURATION_MS = 4_000;

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
 * Grant 1 blowgun + 5 darts to the player and equip the blowgun into
 * the dedicated slot via the admin endpoint.
 */
async function setupAttackerWithBlowgun(
  page: Page,
  playerId: number,
): Promise<void> {
  await adminGiveItem(playerId, AdminItemId.Blowgun, 1);
  await adminGiveItem(playerId, AdminItemId.PoisonDart, 5);
  await page.waitForFunction(
    () => window.__anarchy!.inventory.countOf(51 as 51) === 1,
  );
  await page.waitForFunction(
    () => window.__anarchy!.inventory.countOf(52 as 52) === 5,
  );
  const slot = await findSlotFor(page, AdminItemId.Blowgun);
  expect(slot).toBeGreaterThanOrEqual(0);
  await adminEquipTool(playerId, "utility", slot);
  await page.waitForFunction(
    () => window.__anarchy!.inventory.getEquippedSlot("utility") !== null,
  );
}

/**
 * Project world `(wx, wy)` to client coords, then dispatch a right-click
 * (`button: 2`) mousedown so the page's break_place handler routes it
 * through the blowgun fire path. Returns the dispatched `(clientX,
 * clientY)` for log inspection.
 */
async function realRightClickAt(
  page: Page,
  wx: number,
  wy: number,
): Promise<{ x: number; y: number }> {
  const vp = page.viewportSize() ?? { width: DEFAULT_VIEW_W, height: DEFAULT_VIEW_H };
  return await page.evaluate(
    ({ wx, wy, vw, vh, cameraHeight, halfFovTan }) => {
      const a = window.__anarchy!;
      const id = a.getLocalPlayerId();
      const me = id === null ? null : a.world.getPlayer(id);
      if (!me) throw new Error("local player not admitted");
      const halfHeight = cameraHeight * halfFovTan;
      const halfWidth = halfHeight * (vw / vh);
      const ndcX = (wx - me.x) / halfWidth;
      const ndcY = (wy - me.y) / halfHeight;
      const clientX = ((ndcX + 1) / 2) * vw;
      const clientY = ((1 - ndcY) / 2) * vh;
      window.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 2,
          clientX,
          clientY,
          bubbles: true,
        }),
      );
      return { x: clientX, y: clientY };
    },
    { wx, wy, vw: vp.width, vh: vp.height, cameraHeight: CAMERA_HEIGHT, halfFovTan: CAMERA_HALF_FOV_TAN },
  );
}

async function readRemoteHp(page: Page, id: number): Promise<number | null> {
  return await page.evaluate((pid: number) => {
    const p = window.__anarchy!.world.getPlayer(pid);
    return p ? p.health : null;
  }, id);
}

test("real-click PvP blowgun: A shoots B, B HP -1, slow indicator, dart count -1", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const selfA = await openClient(a, "bg-pvp-a");
    const selfB = await openClient(b, "bg-pvp-b");

    // Pin both 5 tiles apart along +x — inside BLOWGUN_RANGE_TILES = 8.
    await adminTeleport(selfA.id, 0.5, 0.5);
    await adminTeleport(selfB.id, 5.5, 0.5);
    await a.waitForFunction(
      (id: number) => {
        const p = window.__anarchy!.world.getPlayer(id);
        return p !== undefined && Math.abs(p.x - 5.5) < 0.1 && Math.abs(p.y - 0.5) < 0.1;
      },
      selfB.id,
    );

    await setupAttackerWithBlowgun(a, selfA.id);

    const hpBefore = await readRemoteHp(b, selfB.id);
    expect(hpBefore).not.toBeNull();

    await realRightClickAt(a, 5.5, 0.5);

    // Within the dart's travel window, B's HP drops by 1.
    await b.waitForFunction(
      ([pid, before]: [number, number]) => {
        const p = window.__anarchy!.world.getPlayer(pid);
        return p !== undefined && p.health < before;
      },
      [selfB.id, hpBefore as number] as const,
      { timeout: CHARGE_MS },
    );
    expect(await readRemoteHp(b, selfB.id)).toBe((hpBefore as number) - 1);

    // B sees themselves as slowed (active Slow effect on local player).
    await b.waitForFunction(() => window.__anarchy!.isLocalPlayerSlowed());

    // A sees a slow indicator over B in the renderer.
    await a.waitForFunction(
      () => window.__anarchy!.getEffectIndicatorCount() >= 1,
    );

    // A's dart count dropped by 1 — was 5, now 4.
    await a.waitForFunction(
      () => window.__anarchy!.inventory.countOf(52 as 52) === 4,
    );

    // After the 4 s slow duration B's effect clears.
    await b.waitForFunction(
      () => !window.__anarchy!.isLocalPlayerSlowed(),
      undefined,
      { timeout: SLOW_DURATION_MS + 2_000 },
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("right-click on a block with blowgun equipped does NOT place a block", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  try {
    const selfA = await openClient(a, "bg-noplace");
    await adminTeleport(selfA.id, 0.5, 0.5);
    await setupAttackerWithBlowgun(a, selfA.id);

    // Make sure the block under cursor is Air so a place would otherwise
    // be valid. Aim at tile (1, 0).
    await adminSetBlock(0, 0, "top", 1, 0, "air");

    // Track the inventory's slot 1 (poison darts) and the world tile's
    // block kind. A successful (wrongful) place would have consumed a
    // dart-or-block; a wrongful fire would have consumed a dart.
    const dartsBefore = await a.evaluate(
      () => window.__anarchy!.inventory.countOf(52 as 52),
    );

    await realRightClickAt(a, 1.5, 0.5);

    // Wait a bit then assert no block was placed at (0,0,1,0). The pick
    // target is a Player or Entity — there's no player or entity at
    // (1.5, 0.5), so the fire path no-ops. Place must not run either.
    await a.waitForTimeout(400);
    const blockKind = await a.evaluate(() => {
      const chunk = window.__anarchy!.terrain.get(0, 0);
      if (!chunk) return null;
      return chunk.top.blocks[0 * 16 + 1]?.kind ?? null;
    });
    expect(blockKind).toBe(0); // BlockType.Air

    // Dart count unchanged — no target under cursor, so no fire dispatched.
    const dartsAfter = await a.evaluate(
      () => window.__anarchy!.inventory.countOf(52 as 52),
    );
    expect(dartsAfter).toBe(dartsBefore);
  } finally {
    await ctxA.close();
  }
});

test("rapid right-clicks: only one dart consumed within the 1 s cooldown", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const selfA = await openClient(a, "bg-cd-a");
    const selfB = await openClient(b, "bg-cd-b");
    await adminTeleport(selfA.id, 0.5, 0.5);
    await adminTeleport(selfB.id, 5.5, 0.5);
    await a.waitForFunction(
      (id: number) => {
        const p = window.__anarchy!.world.getPlayer(id);
        return p !== undefined && Math.abs(p.x - 5.5) < 0.1;
      },
      selfB.id,
    );
    await setupAttackerWithBlowgun(a, selfA.id);

    // Two right-clicks in quick succession.
    await realRightClickAt(a, 5.5, 0.5);
    await realRightClickAt(a, 5.5, 0.5);

    // Only the first fire consumes a dart.
    await a.waitForFunction(
      () => window.__anarchy!.inventory.countOf(52 as 52) === 4,
    );
    await a.waitForTimeout(400);
    const darts = await a.evaluate(
      () => window.__anarchy!.inventory.countOf(52 as 52),
    );
    expect(darts).toBe(4);

    // After ≥ 1 s the gate clears and a fresh fire succeeds (consumes
    // another dart).
    await a.waitForTimeout(1_100);
    await realRightClickAt(a, 5.5, 0.5);
    await a.waitForFunction(
      () => window.__anarchy!.inventory.countOf(52 as 52) === 3,
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("spider target: dart takes 1 HP and applies a slow indicator", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  try {
    const selfA = await openClient(a, "bg-spider");
    await adminTeleport(selfA.id, 0.5, 0.5);
    const spiderId = await adminSpawnEntity("spider", 3, 0);
    await a.waitForFunction(
      (sid: number) => {
        for (const [, chunk] of window.__anarchy!.terrain.iter()) {
          if (chunk.entities.has(sid)) return true;
        }
        return false;
      },
      spiderId,
    );
    await setupAttackerWithBlowgun(a, selfA.id);

    // Read the spider's tile so we shoot where it is right now.
    const where = await a.evaluate((sid: number) => {
      for (const [, chunk] of window.__anarchy!.terrain.iter()) {
        const e = chunk.entities.get(sid);
        if (e) return { x: e.tileX + 0.5, y: e.tileY + 0.5 };
      }
      return null;
    }, spiderId);
    if (where === null) throw new Error("spider not in any loaded chunk");
    await realRightClickAt(a, where.x, where.y);

    // Spider's HP drops; visible slow indicator appears on A's renderer.
    await a.waitForFunction(
      (sid: number) => {
        for (const [, chunk] of window.__anarchy!.terrain.iter()) {
          const e = chunk.entities.get(sid);
          if (e) return e.health < 20;
        }
        return false;
      },
      spiderId,
      { timeout: CHARGE_MS },
    );
    await a.waitForFunction(
      () => window.__anarchy!.getEffectIndicatorCount() >= 1,
    );
  } finally {
    await ctx.close();
  }
});

test("out-of-range right-click: no dart consumed, no projectile, no HP change", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const selfA = await openClient(a, "bg-oor-a");
    const selfB = await openClient(b, "bg-oor-b");
    // 10 tiles apart — beyond BLOWGUN_RANGE_TILES = 8.
    await adminTeleport(selfA.id, 0.5, 0.5);
    await adminTeleport(selfB.id, 10.5, 0.5);
    await a.waitForFunction(
      (id: number) => {
        const p = window.__anarchy!.world.getPlayer(id);
        return p !== undefined && Math.abs(p.x - 10.5) < 0.5;
      },
      selfB.id,
    );
    await setupAttackerWithBlowgun(a, selfA.id);

    const hpBefore = await readRemoteHp(b, selfB.id);
    const dartsBefore = await a.evaluate(
      () => window.__anarchy!.inventory.countOf(52 as 52),
    );

    await realRightClickAt(a, 10.5, 0.5);

    // Wait long enough for any wire round-trip + cooldown — then assert
    // nothing happened on either side.
    await a.waitForTimeout(600);
    expect(await readRemoteHp(b, selfB.id)).toBe(hpBefore);
    const dartsAfter = await a.evaluate(
      () => window.__anarchy!.inventory.countOf(52 as 52),
    );
    expect(dartsAfter).toBe(dartsBefore);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
