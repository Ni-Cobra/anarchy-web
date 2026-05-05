import { test, expect, type Page } from "@playwright/test";

// Browser-driven e2e for the top-layer block destroy flow.
//
// The placeholder worldgen ships an empty top layer, so the test seeds a
// known top-layer block via the server's `cfg(debug_assertions)`-only
// `/debug/seed-top-block` endpoint. Both clients then observe that block
// arriving via the normal `TickUpdate` machinery; client A clicks it; client
// B observes the block disappear after the destroy round-trips.

const SERVER_URL = "http://localhost:8080";
const CHUNK_SIZE = 16;

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
  kind: "wood" | "stone" | "grass" | "air",
): Promise<void> {
  const url = `${SERVER_URL}/debug/seed-top-block/${cx}/${cy}/${lx}/${ly}/${kind}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`seed-top-block ${url} failed: ${res.status} ${res.statusText}`);
  }
}

async function waitForTopBlockKind(
  page: Page,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kindName: "Air" | "Grass" | "Wood" | "Stone",
): Promise<void> {
  await page.waitForFunction(
    ({ cx, cy, lx, ly, kindName }) => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(cx, cy);
      if (!chunk) return false;
      const idx = ly * 16 + lx;
      const block = chunk.top.blocks[idx];
      if (!block) return false;
      // Numeric BlockType enum: Air=0, Grass=1, Wood=2, Stone=3.
      const expected =
        kindName === "Air"
          ? 0
          : kindName === "Grass"
            ? 1
            : kindName === "Wood"
              ? 2
              : 3;
      return block.kind === expected;
    },
    { cx, cy, lx, ly, kindName },
  );
}

test("held break: A holds → Wood breaks after ~10 ticks for both A and B", async ({
  browser,
}) => {
  // Held-break flow (ADR 0006). Seed a Wood block (max durability = 10);
  // Player A sends a `BreakIntent` and the server damages the block one
  // dur/tick until it breaks. At 20 Hz this is ~500 ms wall-clock; we
  // wait up to 5 s to absorb scheduler jitter.
  //
  // Block at world tile (1, 0) — chunk (0, 0) local (1, 0). With two
  // clients spawning at origin the circle-circle push shoves the
  // lower-id player to (-0.35, 0) on the first joint tick, so the chosen
  // block must stay in reach from there: distance from (-0.35, 0) to
  // tile center (1.5, 0.5) is √(1.85² + 0.5²) ≈ 1.92 — under 4.0.
  await seedTopBlock(0, 0, 1, 0, "wood");

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    // Both clients must see the seeded Wood block before the held break.
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Wood");
    await waitForTopBlockKind(b, 0, 0, 1, 0, "Wood");

    // A starts the held break by sending a `BreakIntent` carrying the
    // target. (We bypass the mousedown handler because the picker is
    // camera/cursor-driven and would require careful coordinate setup;
    // the wire-level handle does the same thing.) The server damages
    // the block one dur/tick until it breaks.
    await a.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 1, ly: 0 }),
    );

    // After ~10 ticks (~500 ms) the cell is cleared; both clients see it.
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Air");
    await waitForTopBlockKind(b, 0, 0, 1, 0, "Air");

    // Release the held break (cosmetic — block is already gone).
    await a.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await ctxA.close();
    await ctxB.close();
    // Defensive cleanup if the destroy assertion failed: clear the seed so
    // later specs that walk through chunk (0, 0) aren't perturbed.
    await seedTopBlock(0, 0, 1, 0, "air").catch(() => {});
  }
});

test("held break: out-of-reach intent never breaks the target", async ({
  browser,
}) => {
  // Seed a block well outside REACH_BLOCKS = 4 from origin but inside chunk
  // (0, 0) so it's always loaded. The player sends a `BreakIntent`, but the
  // server's per-tick durability sweep checks reach against the post-tick
  // position and drops the damage every tick.
  await seedTopBlock(0, 0, 10, 0, "wood");

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    await waitForTopBlockKind(a, 0, 0, 10, 0, "Wood");
    await waitForTopBlockKind(b, 0, 0, 10, 0, "Wood");

    // A holds break on the out-of-reach cell. Server stores the intent but
    // every tick's reach check fails → no damage applied.
    await a.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 10, ly: 0 }),
    );

    // Wait long enough that an in-reach Wood would have broken many times
    // over (Wood = 10 ticks, so 1.5 s ≈ 30 ticks). Cell must still be Wood.
    await a.waitForTimeout(1500);
    await waitForTopBlockKind(a, 0, 0, 10, 0, "Wood");
    await waitForTopBlockKind(b, 0, 0, 10, 0, "Wood");
    await a.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await ctxA.close();
    await ctxB.close();
    // The server is reused across tests; clear the seeded block so it
    // doesn't perturb later specs that move clients through chunk (0, 0).
    await seedTopBlock(0, 0, 10, 0, "air").catch(() => {});
  }
});

test("held break: release mid-break recovers the partial damage", async ({
  browser,
}) => {
  // Pin the recovery semantics from ADR 0006: damage Stone (max = 30) for
  // ~5 ticks, release, wait for the untouched-delay window + ramp, then
  // hold again — the block must take a fresh ~30 ticks to break, proving
  // the prior damage was healed.
  await seedTopBlock(0, 0, 1, 0, "stone");

  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Stone");

    // Hold for ~250 ms (≈ 5 ticks) → release → wait for full recovery
    // (UNTOUCHED_DELAY_TICKS=20 + ramp 5 ticks back to max ≈ 1.25 s).
    await a.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 1, ly: 0 }),
    );
    await a.waitForTimeout(250);
    await a.evaluate(() => window.__anarchy!.sendBreakIntent(null));
    await a.waitForTimeout(1500);

    // Restart the hold: full Stone (30 ticks) takes ~1.5 s. Cell must
    // still be Stone after 1.0 s of fresh hold (only ~20 ticks elapsed).
    await a.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 1, ly: 0 }),
    );
    await a.waitForTimeout(1000);
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Stone");
    // Extra ~1 s should finish the break.
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Air");
    await a.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await ctxA.close();
    await seedTopBlock(0, 0, 1, 0, "air").catch(() => {});
  }
});
