import { test, expect, type Page } from "@playwright/test";

// BACKLOG task 100 e2e: client wiring of the server-side crafting flow
// (task 090 server). The fresh-admit inventory has 10 Gold (slot 0) and
// the 10 task-090 starter tools planted at the bottom of the panel — no
// wood / sticks, so the crafting list starts empty. The spec drives the
// full loop:
//   1. Open the inventory (E). Crafting panel slides in from the right.
//   2. Plant Wood + Stick into the inventory via the dev-utils admin
//      seam, observe the recipe rows light up.
//   3. Click the `wood-pickaxe` row → server applies the recipe and the
//      next InventoryUpdate carries one fewer Wood, two fewer Sticks,
//      and a fresh WoodPickaxe.

const SERVER_URL = "http://localhost:8080";

// ItemId numeric values mirror `anarchy.proto`'s `ItemId` enum. Used both
// here in the test harness and inside `page.evaluate` closures (which
// can't capture lexical scope across the worker boundary — values get
// inlined or threaded through the closure arg).
const ITEM_ID_STICK = 1;
const ITEM_ID_WOOD = 2;
// Task 580: wood-pickaxe and wood-shovel now consume `Log` (ItemId = 35
// — the felled-tree drop from task 390) rather than `Wood` planks.
const ITEM_ID_LOG = 35;

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

async function seedInventory(page: Page, item: number, count: number): Promise<void> {
  const playerId = await page.evaluate(() =>
    window.__anarchy!.getLocalPlayerId()!,
  );
  const url = `${SERVER_URL}/debug/seed-inventory/${playerId}/${item}/${count}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`seed-inventory failed: ${res.status}`);
}

test("opening the inventory slides the crafting panel in alongside it; closing slides it out", async ({
  page,
}) => {
  await openClient(page, "craft-toggle");

  // Both panels are off-screen by default — neither has the `.open` class.
  await expect(page.locator(".anarchy-inventory-panel.open")).toHaveCount(0);
  await expect(page.locator(".anarchy-crafting-panel.open")).toHaveCount(0);

  // Press E → both panels open together.
  await page.keyboard.press("KeyE");
  await expect(page.locator(".anarchy-inventory-panel.open")).toHaveCount(1);
  await expect(page.locator(".anarchy-crafting-panel.open")).toHaveCount(1);

  // Press E again → both panels close together.
  await page.keyboard.press("KeyE");
  await expect(page.locator(".anarchy-inventory-panel.open")).toHaveCount(0);
  await expect(page.locator(".anarchy-crafting-panel.open")).toHaveCount(0);

  // Escape from the open state also closes both (matches task spec).
  await page.keyboard.press("KeyE");
  await expect(page.locator(".anarchy-crafting-panel.open")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".anarchy-inventory-panel.open")).toHaveCount(0);
  await expect(page.locator(".anarchy-crafting-panel.open")).toHaveCount(0);
});

test("crafting panel starts empty (no wood) then populates as recipe ingredients arrive", async ({
  page,
}) => {
  await openClient(page, "craft-empty");

  // Without wood / sticks, the panel shows the empty placeholder.
  await page.keyboard.press("KeyE");
  await expect(page.locator(".anarchy-crafting-empty")).toBeVisible();
  await expect(page.locator(".anarchy-crafting-row")).toHaveCount(0);

  // Drop one log of wood into the inventory via the dev seam — the next
  // InventoryUpdate carries the recipe id `"sticks"` and the panel
  // re-renders with a single row.
  await seedInventory(page, ITEM_ID_WOOD, 1);
  await expect(page.locator(".anarchy-crafting-row")).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='sticks']"),
  ).toHaveCount(1);
});

test("clicking a row ships CraftRequest; server consumes ingredients and inserts the output", async ({
  page,
}) => {
  await openClient(page, "craft-pickaxe");

  // Stage enough logs + sticks that wood-pickaxe is craftable (task 580:
  // wood-pickaxe now consumes 3 Log + 2 Stick instead of Wood planks).
  // The available_recipes list pools across the inventory + hotbar so a
  // single InventoryUpdate after both seeds will carry the recipe id.
  await seedInventory(page, ITEM_ID_LOG, 3);
  await seedInventory(page, ITEM_ID_STICK, 2);

  await page.keyboard.press("KeyE");
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='wood-pickaxe']"),
  ).toHaveCount(1, { timeout: 5_000 });

  // Snapshot starting counts so the post-craft assertions are exact.
  // The starter loadout already plants one Wood Pickaxe in the panel, so
  // we count *deltas* against `before` rather than absolute totals.
  const before = await page.evaluate(() => {
    const inv = window.__anarchy!.inventory;
    return {
      log: inv.countOf(35),
      stick: inv.countOf(1),
      pickaxe: inv.countOf(5),
    };
  });
  expect(before.log).toBe(3);
  expect(before.stick).toBe(2);
  const startingPickaxe = before.pickaxe;

  await page
    .locator(".anarchy-crafting-row[data-recipe-id='wood-pickaxe']")
    .click();

  // Server applies the recipe: 3 logs + 2 sticks consumed, 1 wood
  // pickaxe inserted. The next InventoryUpdate makes it visible to the
  // client mirror.
  await page.waitForFunction(
    (start: number) => {
      const inv = window.__anarchy!.inventory;
      return (
        inv.countOf(35) === 0 &&
        inv.countOf(1) === 0 &&
        inv.countOf(5) === start + 1
      );
    },
    startingPickaxe,
  );
  // Task 460: the cursor is still hovering the row (Playwright moves it
  // there for the click), so the row stays in the list as an `uncraftable`
  // orphan — that's what prevents stray clicks from drifting onto a
  // sibling row that just shifted into place.
  const orphan = page.locator(
    ".anarchy-crafting-row[data-recipe-id='wood-pickaxe']",
  );
  await expect(orphan).toHaveClass(/uncraftable/);
  // Once the cursor leaves the panel, the orphan is dropped and the
  // natural layout takes over.
  await page.mouse.move(10, 10);
  await expect(orphan).toHaveCount(0);
});

test("multi-stack ingredient row renders both ingredient stacks on the left half", async ({
  page,
}) => {
  await openClient(page, "craft-multi");
  await seedInventory(page, ITEM_ID_WOOD, 5);
  await seedInventory(page, ITEM_ID_STICK, 4);
  await page.keyboard.press("KeyE");

  // wood-axe = 3 Wood + 2 Stick → 1 WoodAxe. Two ingredient stacks on
  // the left, one output stack on the right, arrow in the middle.
  const row = page.locator(".anarchy-crafting-row[data-recipe-id='wood-axe']");
  await expect(row).toHaveCount(1, { timeout: 5_000 });

  const ingredientStacks = row.locator(
    ".anarchy-crafting-side.left .anarchy-crafting-stack",
  );
  const outputStacks = row.locator(
    ".anarchy-crafting-side.right .anarchy-crafting-stack",
  );
  await expect(ingredientStacks).toHaveCount(2);
  await expect(outputStacks).toHaveCount(1);
  await expect(row.locator(".anarchy-crafting-arrow")).toHaveText("→");
});

