import { test, expect, type Page } from "@playwright/test";

// BACKLOG task 130 e2e: equipping a high-tier pickaxe slashes the time it
// takes to break a Stone block. Pure timing pin — the per-tier multiplier
// matrix lives in the server-side integration tests; here we just confirm
// the wire end-to-end (equip → break) actually shortens the break.
//
// Stone has max durability 90 (post-task 580 ×3). Bare base rate (1
// dur/tick) is 90 ticks ≈ 4500 ms. Tungsten Pickaxe applies 10 dur/tick
// → 9 ticks ≈ 450 ms. We assert the break completes inside a 1500 ms
// window — comfortably above the ideal 450 ms (margin for tick alignment
// + RTT) but far enough below 4500 ms that a regression dropping the
// multiplier would surface here.

const SERVER_URL = "http://localhost:8080";
const HOTBAR_SLOTS = 9;
// `STARTER_TOOL_LOADOUT` (anarchy-server/src/network/hub.rs) plants the
// tungsten pickaxe at panel slot 30 → flat slot HOTBAR_SLOTS + 30.
const TUNGSTEN_PICKAXE_SLOT = HOTBAR_SLOTS + 30;
// `ItemId.TungstenPickaxe` from the client mirror.
const ITEM_ID_TUNGSTEN_PICKAXE = 9;

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  // Wait for admission + the starter inventory frame: the pickaxe lands
  // at its known slot and the local player id is non-null.
  await page.waitForFunction(
    ({ slot, expected }) => {
      const a = window.__anarchy;
      if (!a) return false;
      if (a.getLocalPlayerId() === null) return false;
      const cell = a.inventory.slot(slot);
      return cell !== null && cell.item === expected;
    },
    { slot: TUNGSTEN_PICKAXE_SLOT, expected: ITEM_ID_TUNGSTEN_PICKAXE },
  );
}

async function seedTopBlock(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kind: "air" | "stone",
): Promise<void> {
  const url = `${SERVER_URL}/debug/seed-top-block/${cx}/${cy}/${lx}/${ly}/${kind}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok)
    throw new Error(`seed-top-block ${url} failed: ${res.status}`);
}

test("equipped Tungsten Pickaxe breaks a Stone block well under the no-tool baseline", async ({
  page,
}) => {
  const cx = 0;
  const cy = 0;
  const lx = 1;
  const ly = 0;
  try {
    await openClient(page, "tool-mine");

    // Equip the tungsten pickaxe and wait for the InventoryUpdate that
    // points the equipped-pickaxe slot at it. The starter loadout
    // auto-equips the wood-tier tool (task 010 rework), so the
    // assertion has to wait for the *new* pointer to land, not just any
    // pickaxe being equipped.
    await page.evaluate((slot) => {
      window.__anarchy!.sendEquipTool(slot, "pickaxe");
    }, TUNGSTEN_PICKAXE_SLOT);
    await page.waitForFunction(
      ({ slot, expected }) => {
        const inv = window.__anarchy!.inventory;
        return (
          inv.getEquippedSlot("pickaxe") === slot &&
          inv.getEquipped("pickaxe") === expected
        );
      },
      { slot: TUNGSTEN_PICKAXE_SLOT, expected: ITEM_ID_TUNGSTEN_PICKAXE },
    );

    // Seed the Stone block in reach (tile center (1.5, 0.5), distance ≈ 1
    // from the spawn at (0.5, 0.5)). Wait for it to arrive on the client.
    await seedTopBlock(cx, cy, lx, ly, "stone");
    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        // BlockType.Stone === 3.
        return chunk.top.blocks[idx]?.kind === 3;
      },
      { cx, cy, lx, ly },
    );

    // Send the break intent and time how long it takes for the cell to
    // flip to Air. Tungsten ≈ 450 ms ideal, no-tool ≈ 4500 ms. 1500 ms
    // is generous over the ideal but well under the no-tool baseline.
    const start = Date.now();
    await page.evaluate(
      ({ cx, cy, lx, ly }) =>
        window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly }),
      { cx, cy, lx, ly },
    );
    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        return chunk.top.blocks[idx]?.kind === 0; // Air
      },
      { cx, cy, lx, ly },
      { timeout: 1500 },
    );
    const elapsed = Date.now() - start;
    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));

    // Sanity bound: the break really did finish inside the window the
    // wait clocked against. (waitForFunction would have rejected past
    // 1500 ms; a passing wait + this assertion documents the margin.)
    expect(elapsed).toBeLessThan(1500);

    // The Stone item drops into inventory on the breaker side. Wait for
    // the InventoryUpdate to land. (count of ItemId.Stone === 3.)
    await page.waitForFunction(
      () => window.__anarchy!.inventory.countOf(3) >= 1,
    );
  } finally {
    // Defensive: clear the seeded block so later specs that walk through
    // chunk (0, 0) aren't perturbed if this test fails mid-run.
    await seedTopBlock(cx, cy, lx, ly, "air").catch(() => {});
  }
});
