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
    // durability 150 (post-task 580 ×3), so this takes ~150 ticks
    // (~7.5 s). Send the break intent and wait for the drop to land in
    // inventory; release once it's done so the heartbeat doesn't keep
    // firing post-break.
    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
    }, [cx, cy, lx, ly] as const);
    await page.waitForFunction(
      () => window.__anarchy!.inventory.countOf(4) === 10,
      undefined,
      { timeout: 12_000 },
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

test("clicking a panel cell ships MoveSlot to the selected hotbar slot", async ({
  page,
}) => {
  // Stage the panel cell first via a programmatic MoveSlot (slot 0 →
  // slot 9 / first panel cell). Then open the side panel and click
  // that panel cell with the mouse — the selected hotbar slot is empty
  // (we just emptied it), so the server moves the whole 10-Gold stack
  // back into slot 0.
  await openClient(page, "inv-click");

  await page.evaluate(() => {
    window.__anarchy!.sendMoveSlot(0, 9);
  });
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    const s9 = a.inventory.slot(9);
    return a.inventory.slot(0) === null && s9 !== null && s9.count === 10;
  });

  // The side panel slides off-screen when closed. `E` toggles it open
  // — bootstrap.ts wires the keybinding to `inventoryUi.toggle()`.
  await page.keyboard.press("KeyE");
  await page.waitForFunction(() => window.__anarchy!.isInventoryOpen());

  // Drive the click via the real mouse to exercise the pointerdown→
  // pointerup gesture without any cursor movement (i.e. below the
  // drag-promotion threshold). The first panel cell is the one that
  // mirrors flat slot index 9.
  const panelCell = page.locator(
    ".anarchy-inventory-panel .anarchy-inventory-slot",
  ).first();
  await panelCell.click();

  // Server applies MoveSlot(9 → 0): slot 9 empties, slot 0 carries the
  // 10-Gold stack again.
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    const s0 = a.inventory.slot(0);
    return s0 !== null && s0.count === 10 && a.inventory.slot(9) === null;
  });
});

test("TransferItems splits a stack between two slots", async ({
  page,
}) => {
  // BACKLOG 410: programmatic `sendTransferItems(0, 5, 3)` splits the
  // seeded 10-Gold stack into 7 + 3 across slot 0 and slot 5 — the
  // partial-transfer primitive the right-click hold flow ships per
  // ramp tick. A second transfer of 99 into the same destination caps
  // at the source count and drains slot 0 entirely.
  await openClient(page, "inv-transfer");

  await page.evaluate(() => {
    window.__anarchy!.sendTransferItems(0, 5, 3);
  });
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    const s0 = a.inventory.slot(0);
    const s5 = a.inventory.slot(5);
    return (
      s0 !== null && s0.count === 7 && s0.item === 4 &&
      s5 !== null && s5.count === 3 && s5.item === 4
    );
  });

  await page.evaluate(() => {
    window.__anarchy!.sendTransferItems(0, 5, 99);
  });
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    const s5 = a.inventory.slot(5);
    return a.inventory.slot(0) === null && s5 !== null && s5.count === 10;
  });
});

test("right-click hold transfer ramps items between slots, releases on pointer-up", async ({
  page,
}) => {
  // BACKLOG 410 user-facing flow: arm slot 0 (hotbar) as the split
  // source, then press-and-hold right-click on a panel cell. The first
  // press fires one transfer immediately; the timer ramps from 500 ms
  // to 100 ms over 2 s. We hold ~1.5 s — enough for at least 3 frames
  // (immediate + two timer ticks) but bounded so the test stays fast.
  // After release we sample the count, sleep past the ramp, and assert
  // the count hasn't moved any further (release stops the timer).
  await openClient(page, "inv-rclick");

  await page.keyboard.press("KeyE");
  await page.waitForFunction(() => window.__anarchy!.isInventoryOpen());

  const sourceCell = page.locator(
    ".anarchy-hotbar .anarchy-inventory-slot",
  ).first();
  const destCell = page.locator(
    ".anarchy-inventory-panel .anarchy-inventory-slot",
  ).first();

  // Arm the split source on the seeded 10-Gold hotbar slot.
  await sourceCell.dispatchEvent("pointerdown", { button: 2 });
  await expect(sourceCell).toHaveClass(/split-source/);

  // Begin a hold on the empty panel cell. The first frame fires on
  // press; subsequent frames pace from 500 ms initially.
  await destCell.dispatchEvent("pointerdown", { button: 2 });

  // Wait until the destination has received at least 3 items — proves
  // the timer is firing past the initial press frame. Bounded at 5 s
  // (well under the slow-start 500 ms × 3 + safety margin).
  await page.waitForFunction(
    () => {
      const s9 = window.__anarchy!.inventory.slot(9);
      return s9 !== null && s9.count >= 3;
    },
    undefined,
    { timeout: 5000 },
  );
  // Release: pointer-up at the document level stops the timer.
  await page.dispatchEvent("body", "pointerup", { button: 2 });

  // Snapshot the post-release count, wait past the fast-interval, and
  // assert no further movement. The source border stays armed (the
  // spec is "release stops the transfer; re-press resumes").
  const afterRelease = await page.evaluate(() => {
    return {
      panel: window.__anarchy!.inventory.slot(9)?.count ?? 0,
      hotbar: window.__anarchy!.inventory.slot(0)?.count ?? 0,
    };
  });
  expect(afterRelease.panel).toBeGreaterThanOrEqual(3);
  expect(afterRelease.panel + afterRelease.hotbar).toBe(10);
  await page.waitForTimeout(400);
  const final = await page.evaluate(() => {
    return {
      panel: window.__anarchy!.inventory.slot(9)?.count ?? 0,
      hotbar: window.__anarchy!.inventory.slot(0)?.count ?? 0,
    };
  });
  expect(final).toEqual(afterRelease);
  await expect(sourceCell).toHaveClass(/split-source/);
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
