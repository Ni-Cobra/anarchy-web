import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminEquipTool,
  adminGiveItem,
  adminTeleport,
} from "./admin";

// Task 310 PvP regression pin: now that the blowgun lives in the
// utility slot (shared with the lantern, NOT mutually exclusive with
// the sword), a real-click PvP shot still routes through
// `apply_projectile_impact` → `damage_player` and applies the
// `Slow` effect on the survival branch. The spec drives the full
// pipeline end-to-end:
//
//   1. A equips the blowgun via the utility slot, holds 4 darts.
//   2. B stands 5 tiles away (in BLOWGUN_RANGE_TILES = 8).
//   3. A right-clicks B → dart spawns, impacts, B's HP -1, dart count
//      -1, slow effect active on B (and visible as an indicator on A).

const CHARGE_MS = 1500;
const DEFAULT_VIEW_W = 1280;
const DEFAULT_VIEW_H = 720;
const CAMERA_HEIGHT = 14;
const CAMERA_HALF_FOV_TAN = Math.tan((30 * Math.PI) / 180);

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

async function setupAttacker(page: Page, playerId: number): Promise<void> {
  await adminGiveItem(playerId, AdminItemId.Blowgun, 1);
  await adminGiveItem(playerId, AdminItemId.PoisonDart, 4);
  await page.waitForFunction(
    () => window.__anarchy!.inventory.countOf(51 as 51) === 1,
  );
  await page.waitForFunction(
    () => window.__anarchy!.inventory.countOf(52 as 52) === 4,
  );
  const slot = await findSlotFor(page, AdminItemId.Blowgun);
  expect(slot).toBeGreaterThanOrEqual(0);
  // Task 310: equip the blowgun through the utility slot.
  await adminEquipTool(playerId, "utility", slot);
  await page.waitForFunction(
    () => window.__anarchy!.inventory.getEquippedSlot("utility") !== null,
  );
}

async function realRightClickAt(
  page: Page,
  wx: number,
  wy: number,
): Promise<void> {
  const vp = page.viewportSize() ?? { width: DEFAULT_VIEW_W, height: DEFAULT_VIEW_H };
  await page.evaluate(
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
    },
    {
      wx,
      wy,
      vw: vp.width,
      vh: vp.height,
      cameraHeight: CAMERA_HEIGHT,
      halfFovTan: CAMERA_HALF_FOV_TAN,
    },
  );
}

async function readRemoteHp(page: Page, id: number): Promise<number | null> {
  return await page.evaluate((pid: number) => {
    const p = window.__anarchy!.world.getPlayer(pid);
    return p ? p.health : null;
  }, id);
}

test("task 310 PvP: blowgun in utility slot still damages and slows the target", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const selfA = await openClient(a, "bg-pvp-310-a");
    const selfB = await openClient(b, "bg-pvp-310-b");

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

    await setupAttacker(a, selfA.id);

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

    // B's view of themselves: Slow is active on the local player.
    await b.waitForFunction(() => window.__anarchy!.isLocalPlayerSlowed());

    // A sees the slow indicator over B in the renderer.
    await a.waitForFunction(
      () => window.__anarchy!.getEffectIndicatorCount() >= 1,
    );

    // A's dart count dropped by 1 — was 4, now 3.
    await a.waitForFunction(
      () => window.__anarchy!.inventory.countOf(52 as 52) === 3,
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
