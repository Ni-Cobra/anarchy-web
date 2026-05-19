import { test, expect, type Page } from "./test-shared";

import { AdminItemId, adminGiveItem } from "./admin";

// Task 190 e2e: craft a blowgun (3 Sticks → 1 Blowgun) and a poison-dart
// stack (1 VenomSack + 2 Sticks → 4 PoisonDart) from admin-granted
// ingredients. Task 310 re-homed the blowgun into the utility slot
// (shared with the lantern), so the post-craft auto-equip lands in
// `getEquippedSlot("utility")` and sword + blowgun can coexist.

const ITEM_ID_BLOWGUN = AdminItemId.Blowgun;
const ITEM_ID_POISON_DART = AdminItemId.PoisonDart;
const ITEM_ID_STICK = AdminItemId.Stick;
const ITEM_ID_VENOM_SACK = AdminItemId.VenomSack;
const ITEM_ID_GOLD = AdminItemId.Gold;
const ITEM_ID_WOOD_SWORD = AdminItemId.WoodSword;

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  // The fresh admit seeds 10 Gold in slot 0; the wait here ensures the
  // first InventoryUpdate has been applied before the spec mutates state.
  await page.waitForFunction((goldId: number) => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(goldId) === 10;
  }, ITEM_ID_GOLD);
}

test("craft blowgun from sticks, craft poison darts from venom + sticks", async ({
  page,
}) => {
  await openClient(page, "blow-craft");

  const playerId = await page.evaluate(() => window.__anarchy!.getLocalPlayerId());
  expect(playerId).not.toBeNull();

  // Seed: 3 Sticks for the blowgun + 1 VenomSack + 2 more Sticks for the
  // dart recipe. Give the 5 sticks in two grants because both recipes
  // share the Stick ingredient and the panel sorts by affordability.
  await adminGiveItem(playerId!, AdminItemId.Stick, 5);
  await adminGiveItem(playerId!, AdminItemId.VenomSack, 1);
  await page.waitForFunction(
    ({ stickId, venomId }) => {
      const inv = window.__anarchy!.inventory;
      return inv.countOf(stickId) === 5 && inv.countOf(venomId) === 1;
    },
    { stickId: ITEM_ID_STICK, venomId: ITEM_ID_VENOM_SACK },
  );

  // Open the inventory + crafting panel and click the blowgun row.
  await page.keyboard.press("KeyE");
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='blowgun']"),
  ).toHaveCount(1, { timeout: 5_000 });
  await page.locator(".anarchy-crafting-row[data-recipe-id='blowgun']").click();

  // Server consumes 3 Sticks → inventory now holds 2 Sticks + 1 Blowgun.
  // Auto-equip on craft (matching the sword/pickaxe/axe pattern) fires
  // because the blowgun slot starts empty.
  await page.waitForFunction(
    ({ stickId, blowgunId }) => {
      const inv = window.__anarchy!.inventory;
      return (
        inv.countOf(stickId) === 2 &&
        inv.countOf(blowgunId) === 1 &&
        inv.getEquippedSlot("utility") !== null
      );
    },
    { stickId: ITEM_ID_STICK, blowgunId: ITEM_ID_BLOWGUN },
  );

  // Click the poison-dart recipe: 1 VenomSack + 2 Sticks → 4 PoisonDart.
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='poison-dart']"),
  ).toHaveCount(1, { timeout: 5_000 });
  await page
    .locator(".anarchy-crafting-row[data-recipe-id='poison-dart']")
    .click();

  await page.waitForFunction(
    ({ stickId, venomId, dartId }) => {
      const inv = window.__anarchy!.inventory;
      return (
        inv.countOf(stickId) === 0 &&
        inv.countOf(venomId) === 0 &&
        inv.countOf(dartId) === 4
      );
    },
    {
      stickId: ITEM_ID_STICK,
      venomId: ITEM_ID_VENOM_SACK,
      dartId: ITEM_ID_POISON_DART,
    },
  );
});

test("task 310: sword and blowgun coexist (no combat-tool slot exclusion)", async ({
  page,
}) => {
  await openClient(page, "blow-equip");

  const playerId = await page.evaluate(() => window.__anarchy!.getLocalPlayerId());
  expect(playerId).not.toBeNull();

  // Seed a blowgun + a wood-sword directly via admin. `give-item` uses raw
  // `try_add` (no auto-equip), so this test ships explicit `EquipTool`
  // actions through the wire. Task 310 dropped the sword↔blowgun
  // exclusion; both slots stay filled across re-equips.
  await adminGiveItem(playerId!, AdminItemId.Blowgun, 1);
  await adminGiveItem(playerId!, AdminItemId.WoodSword, 1);
  await page.waitForFunction(
    ({ blowgunId, swordId }) => {
      const inv = window.__anarchy!.inventory;
      return inv.countOf(blowgunId) === 1 && inv.countOf(swordId) === 1;
    },
    { blowgunId: ITEM_ID_BLOWGUN, swordId: ITEM_ID_WOOD_SWORD },
  );

  const findSlot = (itemId: number): Promise<number> =>
    page.evaluate((id: number) => {
      const inv = window.__anarchy!.inventory;
      for (let i = 0; i < 45; i++) {
        const s = inv.slot(i);
        if (s !== null && s.item === id) return i;
      }
      return -1;
    }, itemId);

  const blowgunSlot = await findSlot(ITEM_ID_BLOWGUN);
  expect(blowgunSlot).toBeGreaterThanOrEqual(0);
  const swordSlot = await findSlot(ITEM_ID_WOOD_SWORD);
  expect(swordSlot).toBeGreaterThanOrEqual(0);

  // Equip the blowgun into the utility slot.
  await page.evaluate((slot: number) => {
    window.__anarchy!.sendEquipTool(slot, "utility");
  }, blowgunSlot);
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        sword: window.__anarchy!.inventory.getEquippedSlot("sword"),
        utility: window.__anarchy!.inventory.getEquippedSlot("utility"),
      })),
    )
    .toEqual({ sword: null, utility: blowgunSlot });

  // Equip the sword — the utility slot (blowgun) must stay in place.
  await page.evaluate((slot: number) => {
    window.__anarchy!.sendEquipTool(slot, "sword");
  }, swordSlot);
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        sword: window.__anarchy!.inventory.getEquippedSlot("sword"),
        utility: window.__anarchy!.inventory.getEquippedSlot("utility"),
      })),
    )
    .toEqual({ sword: swordSlot, utility: blowgunSlot });
});
