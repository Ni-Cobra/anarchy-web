import { test, expect, type Page } from "@playwright/test";

// Anti-cheat occlusion (task 060): blocks the player cannot see should never
// reach the client as their true kind. The server masks fully-occluded
// non-Air cells with a `Hidden` wire variant (proto integer = 7); the
// underlying type stays server-side. Breaking one of the four orthogonal
// neighbors un-hides the cell, and the next per-client TickUpdate ships
// the real kind.

const SERVER_URL = "http://localhost:8080";

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page): Promise<void> {
  await page.goto("/?username=tester&color=0");
  await page.waitForFunction(() => window.__anarchy !== undefined);
}

async function waitForSelfSpawn(page: Page): Promise<SelfView> {
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      if (id === null || id === 0) return null;
      const me = a.world.getPlayer(id);
      if (!me) return null;
      return { id: me.id, x: me.x, y: me.y };
    })
    .then((handle) => handle.jsonValue() as Promise<SelfView>);
}

async function seedTopBlock(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kind: "wood" | "stone" | "grass" | "air" | "gold",
): Promise<void> {
  const url = `${SERVER_URL}/debug/seed-top-block/${cx}/${cy}/${lx}/${ly}/${kind}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`seed-top-block ${url} failed: ${res.status} ${res.statusText}`);
  }
}

async function waitForTopBlockKindEnum(
  page: Page,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  expected: number,
): Promise<void> {
  await page.waitForFunction(
    ({ cx, cy, lx, ly, expected }) => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(cx, cy);
      if (!chunk) return false;
      const idx = ly * 16 + lx;
      const block = chunk.top.blocks[idx];
      if (!block) return false;
      return block.kind === expected;
    },
    { cx, cy, lx, ly, expected },
  );
}

// `BlockType` numeric values (mirrored from server proto):
const AIR = 0;
const STONE = 3;
const GOLD = 4;
const HIDDEN = 7;

test("buried Gold ships as Hidden, then reveals after a neighbor breaks", async ({
  browser,
}) => {
  // Setup: a 3×3 ring of Stone surrounds a Gold cell at (5, 5). Gold has
  // four full Stone orthogonal neighbors → server's `is_hidden_top` returns
  // true → wire ships HIDDEN.
  //
  // Seed the surrounding Stones first; the Gold last so its eventual
  // un-hide isn't ambiguous. The 3×3 ring is at (4..=6, 4..=6).
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const lx = 5 + dx;
      const ly = 5 + dy;
      if (dx === 0 && dy === 0) continue;
      await seedTopBlock(0, 0, lx, ly, "stone");
    }
  }
  await seedTopBlock(0, 0, 5, 5, "gold");

  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    // Buried Gold ships as HIDDEN — the client never sees the underlying
    // GOLD enum integer, only HIDDEN.
    await waitForTopBlockKindEnum(a, 0, 0, 5, 5, HIDDEN);
    // The Stone neighbors of Gold (e.g. (4, 5)) are themselves visible —
    // they each have at least one non-full orthogonal neighbor (the
    // surrounding world is Air outside the 3×3 ring). They ship as STONE.
    await waitForTopBlockKindEnum(a, 0, 0, 4, 5, STONE);

    // Break the east-of-Gold Stone neighbor authoritatively (server side).
    // After this mutation the Gold cell now has only three full neighbors
    // → un-hidden. The next per-client TickUpdate must re-emit chunk
    // (0, 0) as full-state and the Gold cell ships as GOLD.
    await seedTopBlock(0, 0, 6, 5, "air");
    await waitForTopBlockKindEnum(a, 0, 0, 5, 5, GOLD);
  } finally {
    await ctx.close();
    // Cleanup: clear the seeded ring so unrelated specs aren't perturbed.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const lx = 5 + dx;
        const ly = 5 + dy;
        await seedTopBlock(0, 0, lx, ly, "air").catch(() => {});
      }
    }
  }
});

test("client never receives the underlying kind for a hidden cell", async ({
  browser,
}) => {
  // Stronger pin of the anti-cheat property: even sampling the client's
  // terrain across many ticks while the cell stays buried, the kind never
  // briefly leaks as GOLD. The server masks at every per-client compose,
  // so any stable-state observation must show HIDDEN.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const lx = 5 + dx;
      const ly = 5 + dy;
      if (dx === 0 && dy === 0) continue;
      await seedTopBlock(0, 0, lx, ly, "stone");
    }
  }
  await seedTopBlock(0, 0, 5, 5, "gold");

  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await waitForTopBlockKindEnum(a, 0, 0, 5, 5, HIDDEN);

    // Sample 25 times across ~500 ms. Every sample must read HIDDEN.
    for (let i = 0; i < 25; i++) {
      const kind = await a.evaluate(() => {
        const a = window.__anarchy!;
        const chunk = a.terrain.get(0, 0)!;
        return chunk.top.blocks[5 * 16 + 5]!.kind;
      });
      expect(kind).toBe(HIDDEN);
      await a.waitForTimeout(20);
    }
  } finally {
    await ctx.close();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const lx = 5 + dx;
        const ly = 5 + dy;
        await seedTopBlock(0, 0, lx, ly, "air").catch(() => {});
      }
    }
  }
});

test("breaking a hidden cell via the wire does nothing", async ({ browser }) => {
  // Server rejects break attempts on hidden cells. A held break-intent on
  // a buried Gold cell never lands a damage tick — the cell stays Gold
  // server-side (we can't directly observe it, but any reveal would flip
  // the wire shape from HIDDEN → AIR). After several seconds of held
  // break, the Gold remains hidden.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const lx = 5 + dx;
      const ly = 5 + dy;
      if (dx === 0 && dy === 0) continue;
      await seedTopBlock(0, 0, lx, ly, "stone");
    }
  }
  await seedTopBlock(0, 0, 5, 5, "gold");

  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await waitForTopBlockKindEnum(a, 0, 0, 5, 5, HIDDEN);

    // Player at origin holds break on (0, 0)/(5, 5) — out of reach
    // (distance ~7.7 > REACH_BLOCKS = 4) so even ignoring the hidden
    // rule, the durability sweep would refuse damage. Seed a closer
    // hidden cell to make this a true reach-OK / hidden-NOT-OK test.
    // Move to (0, 0)/(2, 2) buried under a 3×3 ring of Stone — distance
    // from origin to (2.5, 2.5) is ~3.5 < 4, well within reach.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const lx = 2 + dx;
        const ly = 2 + dy;
        if (dx === 0 && dy === 0) continue;
        await seedTopBlock(0, 0, lx, ly, "stone");
      }
    }
    await seedTopBlock(0, 0, 2, 2, "gold");
    await waitForTopBlockKindEnum(a, 0, 0, 2, 2, HIDDEN);

    await a.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 2, ly: 2 }),
    );
    // Wait > 150 ticks (Gold max durability = 150 post-task 580 ×3,
    // would break in ~7.5 s if damage applied). Cell must remain HIDDEN.
    await a.waitForTimeout(8500);
    const kind = await a.evaluate(() => {
      const a = window.__anarchy!;
      const chunk = a.terrain.get(0, 0)!;
      return chunk.top.blocks[2 * 16 + 2]!.kind;
    });
    expect(kind).toBe(HIDDEN);
    await a.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await ctx.close();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const center of [
          [5, 5],
          [2, 2],
        ]) {
          const lx = center[0] + dx;
          const ly = center[1] + dy;
          await seedTopBlock(0, 0, lx, ly, "air").catch(() => {});
        }
      }
    }
  }
});
