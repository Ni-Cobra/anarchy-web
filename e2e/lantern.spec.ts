import { test, expect, type Page } from "@playwright/test";
import { adminGiveItem, AdminItemId, adminSetTimeOfDay } from "./admin";

// Task 370 e2e: the lantern's full loop. Plant Iron + Torch via admin,
// craft the lantern, equip it into the Utility slot, jump to midnight,
// and assert the player-attached point light lands in the WebGL scene.
//
// `getLanternLightCount()` is a thin pass-through to the renderer's
// per-frame `LanternLights.visibleCount()` — non-zero means the layer
// has at least one visible warm point light pinned at a player whose
// `equippedUtility === Lantern`.

const DAY_LENGTH_SECONDS = 600;

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  // Fresh-admit seeds 10 Gold (item id 4) in slot 0 — wait for that
  // landmark so the inventory mirror is hot before we start dropping
  // ingredients.
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
  });
}

test.describe.configure({ mode: "serial" });

test("craft + equip lantern, advance to night, the lantern light lands in the scene", async ({
  page,
}) => {
  test.setTimeout(20_000);
  // Start in daylight so the renderer's torch + lantern pools sit at
  // intensity 0 — non-zero count later cleanly attributes to the
  // night-phase advance.
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.25);

  await openClient(page, "lantern-e2e");
  const playerId = await page.evaluate(() => window.__anarchy!.getLocalPlayerId()!);

  // Plant 1 Torch + 1 IronIngot. The recipe asks for exactly that pair.
  await adminGiveItem(playerId, AdminItemId.Torch, 1);
  await adminGiveItem(playerId, AdminItemId.IronIngot, 1);
  await page.waitForFunction(() => {
    const inv = window.__anarchy!.inventory;
    return inv.countOf(33) === 1 && inv.countOf(31) === 1;
  });

  // Recipe should now satisfy — fire `CraftRequest("lantern")` and wait
  // for the next `InventoryUpdate` to insert the lantern.
  await page.evaluate(() => window.__anarchy!.sendCraft("lantern"));
  await page.waitForFunction(() => {
    const inv = window.__anarchy!.inventory;
    return inv.countOf(34) === 1 && inv.countOf(33) === 0 && inv.countOf(31) === 0;
  });

  // Find the cell the freshly-crafted lantern landed in (auto-equip
  // doesn't fire because the inventory has 10 Gold ahead of it; the
  // crafting `try_add_with_auto_equip` only flips the equipment slot
  // when no utility item is already in inventory under the auto-equip
  // rules). Walk the slots and find the cell holding ItemId.Lantern.
  const lanternSlot = await page.evaluate(() => {
    const inv = window.__anarchy!.inventory;
    const slots = inv.allSlots();
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i]!.item === 34) return i;
    }
    return -1;
  });
  expect(lanternSlot).toBeGreaterThanOrEqual(0);

  // Equip the lantern. ToolKind.Utility = 3 on the wire.
  await page.evaluate((slot) => {
    window.__anarchy!.sendEquipTool(slot, "utility");
  }, lanternSlot);

  // Wait for the next chunk-delivered PlayerSnapshot to carry the
  // lantern through the wire. The renderer's `LanternLights.update()`
  // runs each frame — at noon every light is hidden, so we also need
  // to advance to midnight before the visible count climbs.
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.75);

  // The lantern light becomes visible once the night factor is non-zero
  // AND the player's PlayerSnapshot carries the lantern. Both happen
  // independently — the wire ships PlayerSnapshot every tick chunk
  // delivery includes the player; the daylight scalar advances with each
  // tick. Polling on `getLanternLightCount() === 1` exercises both.
  await page.waitForFunction(
    () => window.__anarchy!.getLanternLightCount() === 1,
    null,
    { timeout: 5_000 },
  );

  // Hand the world back to "day" so any spec running after this one
  // doesn't inherit a forced night.
  await adminSetTimeOfDay(0);
});

test("unequipping the lantern drops the player-attached light", async ({ page }) => {
  test.setTimeout(20_000);
  await adminSetTimeOfDay(DAY_LENGTH_SECONDS * 0.75);

  await openClient(page, "lantern-off");
  const playerId = await page.evaluate(() => window.__anarchy!.getLocalPlayerId()!);

  // Plant a pre-built lantern directly so the test stays focused on the
  // equip → unequip transition (the craft path is covered above).
  await adminGiveItem(playerId, AdminItemId.Lantern, 1);
  await page.waitForFunction(() => window.__anarchy!.inventory.countOf(34) === 1);

  const lanternSlot = await page.evaluate(() => {
    const inv = window.__anarchy!.inventory;
    const slots = inv.allSlots();
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i]!.item === 34) return i;
    }
    return -1;
  });
  expect(lanternSlot).toBeGreaterThanOrEqual(0);

  await page.evaluate((slot) => {
    window.__anarchy!.sendEquipTool(slot, "utility");
  }, lanternSlot);
  await page.waitForFunction(
    () => window.__anarchy!.getLanternLightCount() === 1,
    null,
    { timeout: 5_000 },
  );

  // Unequip: the next PlayerSnapshot reports the utility slot empty,
  // the lantern-light pool drops the per-player light.
  await page.evaluate(() => {
    window.__anarchy!.sendUnequipTool("utility");
  });
  await page.waitForFunction(
    () => window.__anarchy!.getLanternLightCount() === 0,
    null,
    { timeout: 5_000 },
  );

  await adminSetTimeOfDay(0);
});
