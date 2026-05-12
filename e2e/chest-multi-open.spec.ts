import { test, expect, type Page } from "@playwright/test";

import { AdminItemId, adminGiveItem, adminSetBlock } from "./admin";

// BACKLOG task 592 e2e: two chests open at once. Exercises the multi-
// panel client end-to-end against the live server:
//   1. Place two chests near origin (server seeds the chest blocks +
//      backing `chests` map entries through the normal placement flow).
//   2. Open both — verify both mirrors land and both panels render with
//      staggered positions.
//   3. Drag panel A's header — verify the `translate(…)` transform shifts.
//   4. Transfer a stack from chest A → chest B and verify it arrives.
//   5. X-click panel A; verify B remains responsive (still mounted, still
//      able to click-withdraw into the player inventory).

const HOTBAR_SLOTS = 9;
const CHEST_A = { cx: 0, cy: 0, lx: 3, ly: 0 } as const;
const CHEST_B = { cx: 0, cy: 0, lx: 3, ly: 1 } as const;

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
  });
}

async function placeChestAt(
  page: Page,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): Promise<void> {
  await page.evaluate((tile) => {
    window.__anarchy!.sendPlaceBlock(tile.cx, tile.cy, tile.lx, tile.ly);
  }, { cx, cy, lx, ly });
  await page.waitForFunction(
    (tile) => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(tile.cx, tile.cy);
      if (!chunk) return false;
      // BlockType.Chest is numeric variant 23 on the wire registry; we
      // only need to confirm the top kind is non-Air at this point — the
      // OpenChest validation will reject if it's not actually a chest.
      const idx = tile.ly * 16 + tile.lx;
      const kind = chunk.top.blocks[idx]?.kind;
      return kind !== undefined && kind !== 0;
    },
    { cx, cy, lx, ly },
  );
}

function transformXY(transform: string): { x: number; y: number } {
  const match = transform.match(
    /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/,
  );
  if (match === null) return { x: NaN, y: NaN };
  return { x: Number(match[1]), y: Number(match[2]) };
}

test("two chests open simultaneously: independent panels, cross-chest transfer, isolated X-close", async ({
  page,
}) => {
  await openClient(page, "chest-multi");

  // The default loadout has 10 Gold in slot 0. Give the player a stack
  // of 2 Chests so a single hotbar slot covers both placements.
  const playerId = await page.evaluate(() =>
    window.__anarchy!.getLocalPlayerId(),
  );
  expect(playerId).not.toBeNull();
  await adminGiveItem(playerId!, AdminItemId.Chest, 2);
  await page.waitForFunction(
    () => window.__anarchy!.inventory.countOf(36) === 2,
  );

  try {
    // give-item lands the chests in the first free slot (slot 1) — select
    // it via the digit keybinding so both the local hotbar mirror AND the
    // server-side authoritative selection move in lockstep before we ship
    // the two `sendPlaceBlock` calls.
    await page.keyboard.press("Digit2");
    await page.waitForFunction(
      () => window.__anarchy!.getSelectedHotbarSlot() === 1,
    );

    await placeChestAt(page, CHEST_A.cx, CHEST_A.cy, CHEST_A.lx, CHEST_A.ly);
    await placeChestAt(page, CHEST_B.cx, CHEST_B.cy, CHEST_B.lx, CHEST_B.ly);
    await page.waitForFunction(
      () => window.__anarchy!.inventory.countOf(36) === 0,
    );

    // Open both chests. Two `ChestUpdate` frames should follow on the
    // next tick — one per chest — and the orchestrator mounts a panel
    // per mirror.
    await page.evaluate((tile) => {
      window.__anarchy!.sendOpenChest(tile.cx, tile.cy, tile.lx, tile.ly);
    }, CHEST_A);
    await page.evaluate((tile) => {
      window.__anarchy!.sendOpenChest(tile.cx, tile.cy, tile.lx, tile.ly);
    }, CHEST_B);

    await page.waitForFunction(
      () => window.__anarchy!.chestState.locations().length === 2,
    );
    await expect(page.locator(".anarchy-chest-panel")).toHaveCount(2);

    // Stagger: the second-mounted panel's transform is offset on both
    // axes from the first.
    const transforms = await page
      .locator(".anarchy-chest-panel")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
    const posA = transformXY(transforms[0]);
    const posB = transformXY(transforms[1]);
    expect(Number.isNaN(posA.x)).toBe(false);
    expect(Number.isNaN(posB.x)).toBe(false);
    expect(posB.x).toBeGreaterThan(posA.x);
    expect(posB.y).toBeGreaterThan(posA.y);

    // Focus stack: newly-opened panel sits on top.
    const zA = await page
      .locator(".anarchy-chest-panel")
      .nth(0)
      .evaluate((el) => Number((el as HTMLElement).style.zIndex));
    const zB = await page
      .locator(".anarchy-chest-panel")
      .nth(1)
      .evaluate((el) => Number((el as HTMLElement).style.zIndex));
    expect(zB).toBeGreaterThan(zA);

    // Drag panel A's header. happy-path: pointerdown on the header, then
    // pointermove on the window, then pointerup — drives the
    // panel_manager's drag state machine end-to-end.
    const headerA = page.locator(".anarchy-chest-panel").nth(0).locator(
      ".anarchy-chest-header",
    );
    const beforeTransform = await page
      .locator(".anarchy-chest-panel")
      .nth(0)
      .evaluate((el) => (el as HTMLElement).style.transform);
    const headerBox = await headerA.boundingBox();
    expect(headerBox).not.toBeNull();
    const startX = headerBox!.x + headerBox!.width / 2;
    const startY = headerBox!.y + headerBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY + 60, { steps: 5 });
    await page.mouse.up();
    const afterTransform = await page
      .locator(".anarchy-chest-panel")
      .nth(0)
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(afterTransform).not.toBe(beforeTransform);

    // Stage a stack of 10 Gold into chest A so we can transfer it
    // across. The default loadout has 10 Gold at player slot 0; ship a
    // `MoveSlot` with `dstChest = CHEST_A`.
    await page.evaluate((tile) => {
      window.__anarchy!.sendMoveSlot(0, 0, null, tile);
    }, CHEST_A);
    await page.waitForFunction(
      ({ tile }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const inv = a.chestState.inventoryFor(tile);
        const s0 = inv?.slot(0) ?? null;
        return s0 !== null && s0.item === 4 && s0.count === 10;
      },
      { tile: CHEST_A },
    );

    // Cross-panel transfer: ship `TransferItems(A.slot0 → B.slot0, 10)`.
    // Server applies it; the next tick's `ChestUpdate`s drain A's slot
    // and populate B's.
    await page.evaluate(({ srcChest, dstChest }) => {
      window.__anarchy!.sendTransferItems(0, 0, 10, srcChest, dstChest);
    }, { srcChest: CHEST_A, dstChest: CHEST_B });
    await page.waitForFunction(
      ({ a, b }) => {
        const handle = window.__anarchy;
        if (!handle) return false;
        const invA = handle.chestState.inventoryFor(a);
        const invB = handle.chestState.inventoryFor(b);
        const sa = invA?.slot(0) ?? null;
        const sb = invB?.slot(0) ?? null;
        return sa === null && sb !== null && sb.item === 4 && sb.count === 10;
      },
      { a: CHEST_A, b: CHEST_B },
    );

    // X-click panel A. The orchestrator ships a `CloseChest` for chest
    // A; the server emits a closing `ChestUpdate` and the mirror is
    // retired. Panel B stays mounted.
    await page
      .locator(".anarchy-chest-panel")
      .nth(0)
      .locator(".anarchy-chest-close")
      .click();
    await page.waitForFunction(
      () => window.__anarchy!.chestState.locations().length === 1,
    );
    await expect(page.locator(".anarchy-chest-panel")).toHaveCount(1);

    // The surviving panel is chest B — its mirror still carries the
    // 10-Gold stack at slot 0.
    const survivorHasGold = await page.evaluate(({ b }) => {
      const inv = window.__anarchy!.chestState.inventoryFor(b);
      const s0 = inv?.slot(0) ?? null;
      return s0 !== null && s0.item === 4 && s0.count === 10;
    }, { b: CHEST_B });
    expect(survivorHasGold).toBe(true);

    // Click chest B's slot 0 — should ship `MoveSlot(chest B → first
    // free main slot)`; with player slot 0 already empty (we moved
    // Gold out earlier), the click-to-withdraw resolver targets the
    // first free panel slot (flat HOTBAR_SLOTS).
    const survivorCell = page
      .locator(".anarchy-chest-panel")
      .locator(".anarchy-chest-slot")
      .first();
    await survivorCell.click();
    await page.waitForFunction(
      ({ slot }) => {
        const inv = window.__anarchy!.inventory;
        const s = inv.slot(slot);
        return s !== null && s.item === 4 && s.count === 10;
      },
      { slot: HOTBAR_SLOTS },
    );
  } finally {
    // Reset the world tiles back to air so subsequent specs in the
    // shared e2e session see a clean slate. Orphaned `chests` map
    // entries are harmless — only `OpenChest` reads them, and it
    // ALSO requires the top kind to be Chest.
    await adminSetBlock(CHEST_A.cx, CHEST_A.cy, "top", CHEST_A.lx, CHEST_A.ly, "air").catch(() => {});
    await adminSetBlock(CHEST_B.cx, CHEST_B.cy, "top", CHEST_B.lx, CHEST_B.ly, "air").catch(() => {});
  }
});
