import { test, expect, type Page } from "@playwright/test";

// BACKLOG task 040 e2e: full inventory-action loop. The fresh-admit seeds
// 10 Gold in slot 0, so the default hotbar selection lets the player
// place Gold on right-click. This spec exercises the wire round-trip
// without driving the picker / mouse:
//   1. Select-slot (digit key) ratchets the inventory mirror's selection.
//   2. Place from slot 0 (server-driven kind via the selected slot)
//      decrements the count from 10 → 9.
//   3. Breaking that placed Gold drops a Gold item back into inventory →
//      count returns to 10.
//   4. MoveSlot (drag) reorders slots — slot 0 empties, the destination
//      now carries 10 Gold.

const SERVER_URL = "http://localhost:8080";

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
  });
}

async function clearTopBlock(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): Promise<void> {
  const url = `${SERVER_URL}/debug/seed-top-block/${cx}/${cy}/${lx}/${ly}/air`;
  await fetch(url, { method: "POST" }).catch(() => {});
}

test("place from selected slot decrements inventory; break replenishes it", async ({
  page,
}) => {
  // ItemId.Gold has numeric value 4 in both the proto enum and the
  // client mirror. Tile (3, 0) is in reach from origin (distance 3.0).
  const cx = 0, cy = 0, lx = 3, ly = 0;
  try {
    await openClient(page, "inv-place");

    // Slot 0 starts at 10 Gold; selection mirror starts at 0.
    expect(await page.evaluate(() => window.__anarchy!.inventory.countOf(4))).toBe(10);

    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendPlaceBlock(cx, cy, lx, ly);
    }, [cx, cy, lx, ly] as const);

    // Both the world and the inventory should reflect the place: cell is
    // Gold, count drops to 9.
    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        return chunk.top.blocks[idx]?.kind === 4;
      },
      { cx, cy, lx, ly },
    );
    await page.waitForFunction(
      () => window.__anarchy!.inventory.countOf(4) === 9,
    );

    // Now break it via the held-break flow (ADR 0006). Gold has max
    // durability 50, so this takes ~50 ticks (~2.5 s). Send the break
    // intent and wait for the drop to land in inventory; release once
    // it's done so the heartbeat doesn't keep firing post-break.
    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
    }, [cx, cy, lx, ly] as const);
    await page.waitForFunction(
      () => window.__anarchy!.inventory.countOf(4) === 10,
      undefined,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await clearTopBlock(cx, cy, lx, ly);
  }
});

test("MoveSlot relocates the seeded Gold stack to a new slot", async ({
  page,
}) => {
  await openClient(page, "inv-move");

  // Slot 0 has 10 Gold; slot 5 is empty. Move 0 → 5 and watch the
  // inventory mirror reflect it on the next InventoryUpdate.
  await page.evaluate(() => {
    window.__anarchy!.sendMoveSlot(0, 5);
  });

  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    const s0 = a.inventory.slot(0);
    const s5 = a.inventory.slot(5);
    return s0 === null && s5 !== null && s5.count === 10 && s5.item === 4;
  });
});

test("SelectSlot mirror locally tracks digit-key selection", async ({
  page,
}) => {
  await openClient(page, "inv-select");

  // Default selection is slot 0; press Digit3 → mirror moves to slot 2.
  expect(
    await page.evaluate(() => window.__anarchy!.getSelectedHotbarSlot()),
  ).toBe(0);
  await page.keyboard.press("Digit3");
  expect(
    await page.evaluate(() => window.__anarchy!.getSelectedHotbarSlot()),
  ).toBe(2);
  // The hotbar's third cell carries the selected highlight class.
  await expect(
    page.locator(".anarchy-hotbar .anarchy-inventory-slot").nth(2),
  ).toHaveClass(/selected/);
});
