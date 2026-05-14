import { test, expect, type Page } from "@playwright/test";

import { adminGiveItem, AdminItemId, adminSetBlock } from "./admin";

// Task 20 e2e: hotbar cells participate in cross-grid drag/drop. The unit
// suite pins the wire actions (`MoveSlot` / `TransferItems` with the
// right cross-grid keys); this spec proves that a real mouse pointerdown
// on a hotbar cell + pointermove + pointerup on a chest cell actually
// drives the dragdrop state machine end-to-end and the server applies
// the move so the chest mirror carries the moved stack.
//
// Bench: the default loadout plants 10 Gold in player hotbar slot 0.
// We place a chest at (cx=0, cy=0, lx=3, ly=0), open it, drag the gold
// from the hotbar into chest slot 4, and verify both inventories.

const CHEST = { cx: 0, cy: 0, lx: 3, ly: 0 } as const;
const ITEM_ID_GOLD = 4;
const ITEM_ID_CHEST = 36;
const CHEST_DST_SLOT = 4;

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(ITEM_ID_GOLD) === 10;
  });
}

async function centerOf(
  page: Page,
  locator: ReturnType<Page["locator"]>,
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test("dragging a hotbar slot onto an open chest panel cell moves the stack to the chest", async ({
  page,
}) => {
  await openClient(page, "hotbar-chest");

  try {
    // Give the player a Chest item, select that hotbar slot, and place
    // the chest at CHEST. The default loadout has no Chest items.
    const playerId = await page.evaluate(() =>
      window.__anarchy!.getLocalPlayerId(),
    );
    expect(playerId).not.toBeNull();
    await adminGiveItem(playerId!, AdminItemId.Chest, 1);
    await page.waitForFunction(
      ({ item }) => window.__anarchy!.inventory.countOf(item) === 1,
      { item: ITEM_ID_CHEST },
    );

    // give-item lands the chest in slot 1. Select it so the place-block
    // flow reads the right hand.
    await page.keyboard.press("Digit2");
    await page.waitForFunction(
      () => window.__anarchy!.getSelectedHotbarSlot() === 1,
    );
    await page.evaluate((tile) => {
      window.__anarchy!.sendPlaceBlock(tile.cx, tile.cy, tile.lx, tile.ly);
    }, CHEST);
    await page.waitForFunction(
      ({ item }) => window.__anarchy!.inventory.countOf(item) === 0,
      { item: ITEM_ID_CHEST },
    );

    await page.evaluate((tile) => {
      window.__anarchy!.sendOpenChest(tile.cx, tile.cy, tile.lx, tile.ly);
    }, CHEST);
    await page.waitForFunction(
      () => window.__anarchy!.chestState.locations().length === 1,
    );
    await expect(page.locator(".anarchy-chest-panel")).toHaveCount(1);

    // Re-select hotbar slot 0 so the source cell we're about to drag is
    // both visually present and the one carrying the 10 Gold.
    await page.keyboard.press("Digit1");
    await page.waitForFunction(
      () => window.__anarchy!.getSelectedHotbarSlot() === 0,
    );

    // Drag with the real mouse: pointerdown on hotbar cell 0, move past
    // DRAG_THRESHOLD_PX_SQ (sqrt(25) = 5 px) so the dragdrop state machine
    // promotes to a drag, then up over chest cell CHEST_DST_SLOT.
    const srcCell = page.locator(".anarchy-hotbar .anarchy-inventory-slot").nth(0);
    const dstCell = page
      .locator(".anarchy-chest-panel .anarchy-chest-slot")
      .nth(CHEST_DST_SLOT);
    const src = await centerOf(page, srcCell);
    const dst = await centerOf(page, dstCell);

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    // Multi-step move ensures pointermove crosses the threshold and the
    // drag promotes before pointerup lands on the destination.
    await page.mouse.move(dst.x, dst.y, { steps: 10 });
    await page.mouse.up();

    // The server applies the move; the next tick ships the InventoryUpdate
    // emptying player slot 0 and the ChestUpdate populating chest slot 4.
    await page.waitForFunction(
      ({ slot, tile }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const inv = a.chestState.inventoryFor(tile);
        const s = inv?.slot(slot) ?? null;
        return s !== null && s.item === ITEM_ID_GOLD && s.count === 10;
      },
      { slot: CHEST_DST_SLOT, tile: CHEST },
    );
    expect(
      await page.evaluate(() => window.__anarchy!.inventory.countOf(ITEM_ID_GOLD)),
    ).toBe(0);
  } finally {
    await adminSetBlock(CHEST.cx, CHEST.cy, "top", CHEST.lx, CHEST.ly, "air").catch(() => {});
  }
});
