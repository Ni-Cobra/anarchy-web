import { test, expect, type Page } from "./test-shared";

import { AdminItemId, adminGiveItem } from "./admin";

// Task 050 e2e: craft a wood sword from raw ingredients (admin-granted Log
// + Stick), verify it appears in inventory, then exercise the sword
// equipment slot — equipping the sword via the wire surface succeeds; the
// matching cell in the panel paints with the red `.equipped-sword`
// highlight; trying to equip a pickaxe into the sword slot fails.

const ITEM_ID_WOOD_SWORD = AdminItemId.WoodSword; // = 44
const ITEM_ID_WOOD_PICKAXE = AdminItemId.WoodPickaxe; // = 5

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  // 4 = ITEM_ID_GOLD; the fresh admit seeds 10 of these in slot 0.
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
  });
}

test("craft wood sword from logs + sticks, equip into sword slot, reject pickaxe into sword slot", async ({
  page,
}) => {
  await openClient(page, "sword-eq");

  const playerId = await page.evaluate(() => window.__anarchy!.getLocalPlayerId());
  expect(playerId).not.toBeNull();

  // Seed exactly the ingredients the wood-sword recipe wants:
  // 3 Log + 2 Stick → 1 WoodSword. Use the admin grant since these aren't
  // in the starter loadout.
  await adminGiveItem(playerId!, AdminItemId.Log, 3);
  await adminGiveItem(playerId!, AdminItemId.Stick, 2);
  await page.waitForFunction(() => {
    const inv = window.__anarchy!.inventory;
    return inv.countOf(35) === 3 && inv.countOf(1) === 2;
  });

  // Open the inventory + crafting panel and click the wood-sword row.
  await page.keyboard.press("KeyE");
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='wood-sword']"),
  ).toHaveCount(1, { timeout: 5_000 });
  await page
    .locator(".anarchy-crafting-row[data-recipe-id='wood-sword']")
    .click();

  // Server consumes 3 Logs + 2 Sticks and inserts 1 wood-sword. The fresh
  // craft also auto-equips because the sword slot was empty (matching the
  // pickaxe / shovel auto-equip path).
  await page.waitForFunction((swordId: number) => {
    const inv = window.__anarchy!.inventory;
    return (
      inv.countOf(35) === 0 &&
      inv.countOf(1) === 0 &&
      inv.countOf(swordId) === 1 &&
      inv.getEquippedSlot("sword") !== null
    );
  }, ITEM_ID_WOOD_SWORD);

  // The cell holding the equipped wood-sword paints with the red
  // `.equipped-sword` highlight (task 050 — distinct from
  // orange/green/yellow/blue of the other tool families).
  const equippedSwordCell = page.locator(
    ".anarchy-inventory-slot.equipped-sword",
  );
  await expect(equippedSwordCell).toHaveCount(1);

  // Find the slot the wood-sword landed in, then try to equip the wood
  // pickaxe (already present in the starter loadout at panel slot 26 /
  // flat slot 35) into the sword slot. The server rejects the kind
  // mismatch silently — the next InventoryUpdate keeps the sword slot
  // pointed at the wood-sword's cell.
  const swordSlot = await page.evaluate((swordId: number) => {
    const inv = window.__anarchy!.inventory;
    for (let i = 0; i < 45; i++) {
      const s = inv.slot(i);
      if (s !== null && s.item === swordId) return i;
    }
    return -1;
  }, ITEM_ID_WOOD_SWORD);
  expect(swordSlot).toBeGreaterThanOrEqual(0);

  // Wire path: ship an EquipTool(WoodPickaxe → Sword) and observe that
  // the equipped sword slot does NOT change. We send the action through
  // the `__anarchy` debug surface (sendEquipTool) and then advance time
  // by waiting for any subsequent InventoryUpdate.
  await page.evaluate((slot: number) => {
    // Try to equip the wood pickaxe (slot 35) into the sword slot. The
    // server's kind check rejects the mismatch silently; the next
    // InventoryUpdate keeps the sword slot pointed at the wood-sword's
    // cell. Cast through `unknown` to ship "sword" as the kind on the
    // wire even if the handle's runtime `ToolKind` narrows tighter.
    window.__anarchy!.sendEquipTool(slot, "sword");
  }, 35);
  // Silence the unused-import lint by referencing the constant once.
  void ITEM_ID_WOOD_PICKAXE;
  // The server ratchets the ack regardless of outcome but the equipped
  // sword pointer must still point at the wood-sword's cell. Give the
  // server one tick to roll back through the bridge, then re-check.
  await page.waitForTimeout(200);
  await expect
    .poll(async () =>
      page.evaluate(() => window.__anarchy!.inventory.getEquippedSlot("sword")),
    )
    .toBe(swordSlot);

  // Sanity: the pickaxe is still in its starter loadout cell (item kind
  // unchanged) — the rejected equip didn't move anything.
  const woodPickaxe = ITEM_ID_WOOD_PICKAXE;
  await expect
    .poll(async () =>
      page.evaluate((pickId: number) => {
        const inv = window.__anarchy!.inventory;
        return inv.slot(35)?.item === pickId;
      }, woodPickaxe),
    )
    .toBe(true);
});
