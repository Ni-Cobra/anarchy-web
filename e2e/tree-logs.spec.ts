import { test, expect, type Page } from "@playwright/test";

// BACKLOG task 390 e2e: trees drop `Log` items into the breaker's
// inventory (not a 3×3 sticks scatter); logs craft into Wood blocks
// (1 → 1) and into Sticks (1 → 4). Drives the full loop:
//   1. Plant a Tree at a known cell via /admin/set-block.
//   2. Held-break the Tree from the browser (the bare-tier path takes 16
//      ticks at 0.05s each — ~0.8s).
//   3. Inventory mirror shows ItemId.Log === 1.
//   4. Open the crafting panel; the `wood-from-log` and `sticks-from-log`
//      rows appear.
//   5. Click `wood-from-log` → log consumed, Wood block lands; click
//      `sticks-from-log` (after seeding another log) → 4 sticks land.

const SERVER_URL = "http://localhost:8080";

const ITEM_ID_STICK = 1;
const ITEM_ID_WOOD = 2;
const ITEM_ID_LOG = 35;

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  // Fresh admit seeds 10 Gold (ItemId.Gold === 4) in slot 0.
  await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return false;
    return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
  });
}

async function setTopBlock(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kind: string,
): Promise<void> {
  const url = `${SERVER_URL}/admin/set-block/${cx}/${cy}/top/${lx}/${ly}/${kind}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`set-block failed: ${res.status}`);
}

async function seedInventory(
  page: Page,
  item: number,
  count: number,
): Promise<void> {
  const playerId = await page.evaluate(() =>
    window.__anarchy!.getLocalPlayerId()!,
  );
  const url = `${SERVER_URL}/debug/seed-inventory/${playerId}/${item}/${count}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`seed-inventory failed: ${res.status}`);
}

test("breaking a Tree drops a Log into the breaker's inventory", async ({
  page,
}) => {
  // Tile (3, 0) is in reach from origin (distance 3.0); Tree max
  // durability is 48 post-task 580 ×3 → ~2.4s of held-break with no
  // equipped axe.
  const cx = 0,
    cy = 0,
    lx = 3,
    ly = 0;
  try {
    await openClient(page, "tree-logs");

    // Pre-condition: no Logs in the inventory yet.
    expect(
      await page.evaluate(
        (id) => window.__anarchy!.inventory.countOf(id),
        ITEM_ID_LOG,
      ),
    ).toBe(0);

    await setTopBlock(cx, cy, lx, ly, "tree");

    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        return chunk.top.blocks[idx]?.kind === 5; // BlockType.Tree === 5
      },
      { cx, cy, lx, ly },
    );

    // Held-break the tree — 48 ticks of bare damage. Send the intent and
    // wait for the Log to land in inventory; release after.
    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
    }, [cx, cy, lx, ly] as const);

    await page.waitForFunction(
      (id) => window.__anarchy!.inventory.countOf(id) >= 1,
      ITEM_ID_LOG,
      { timeout: 8000 },
    );
    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await setTopBlock(cx, cy, lx, ly, "air");
  }
});

test("crafting wood-from-log consumes a Log and yields a Wood block", async ({
  page,
}) => {
  await openClient(page, "log-craft-wood");
  await seedInventory(page, ITEM_ID_LOG, 1);

  await page.keyboard.press("KeyE");
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='wood-from-log']"),
  ).toHaveCount(1, { timeout: 5_000 });

  const before = await page.evaluate(
    (ids) => ({
      log: window.__anarchy!.inventory.countOf(ids.log),
      wood: window.__anarchy!.inventory.countOf(ids.wood),
    }),
    { log: ITEM_ID_LOG, wood: ITEM_ID_WOOD },
  );
  expect(before.log).toBe(1);

  await page
    .locator(".anarchy-crafting-row[data-recipe-id='wood-from-log']")
    .click();

  await page.waitForFunction(
    (b) => {
      const inv = window.__anarchy!.inventory;
      return (
        inv.countOf(35 /* Log */) === b.log - 1 &&
        inv.countOf(2 /* Wood */) === b.wood + 1
      );
    },
    before,
  );
});

test("crafting sticks-from-log consumes a Log and yields four Sticks", async ({
  page,
}) => {
  await openClient(page, "log-craft-sticks");
  await seedInventory(page, ITEM_ID_LOG, 1);

  await page.keyboard.press("KeyE");
  await expect(
    page.locator(".anarchy-crafting-row[data-recipe-id='sticks-from-log']"),
  ).toHaveCount(1, { timeout: 5_000 });

  const before = await page.evaluate(
    (ids) => ({
      log: window.__anarchy!.inventory.countOf(ids.log),
      stick: window.__anarchy!.inventory.countOf(ids.stick),
    }),
    { log: ITEM_ID_LOG, stick: ITEM_ID_STICK },
  );
  expect(before.log).toBe(1);

  await page
    .locator(".anarchy-crafting-row[data-recipe-id='sticks-from-log']")
    .click();

  await page.waitForFunction(
    (b) => {
      const inv = window.__anarchy!.inventory;
      return (
        inv.countOf(35 /* Log */) === b.log - 1 &&
        inv.countOf(1 /* Stick */) === b.stick + 4
      );
    },
    before,
  );
});
