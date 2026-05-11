import { test, expect, type Page } from "@playwright/test";
import { adminSetBlock } from "./admin";

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

test("ground-replace held break drops the broken kind into the breaker's inventory", async ({
  page,
}) => {
  // Plant Wood on the ground at (3, 0). The default loadout has 10 Gold in
  // slot 0 (`places_block = Gold`, `is_full = true`), so a held break
  // resolves as a ground-replace: ground swaps to Gold, slot 0 drops to 9,
  // and the broken Wood drops into the breaker's inventory in the same
  // tick (numeric `ItemId.Wood` = 2 / `BlockType.Gold` = 4 mirror the
  // server registry).
  const cx = 0,
    cy = 0,
    lx = 3,
    ly = 0;
  await adminSetBlock(cx, cy, "ground", lx, ly, "wood");

  try {
    await page.goto(`/?username=ground-drop&color=0`);
    await page.waitForFunction(() => window.__anarchy !== undefined);
    await page.waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return false;
      return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
    });

    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        const ground = chunk.ground.blocks[idx];
        return !!ground && ground.kind === 2;
      },
      { cx, cy, lx, ly },
    );
    expect(
      await page.evaluate(() => window.__anarchy!.inventory.countOf(2)),
    ).toBe(0);

    // Wood max_durability = 10 → ~10 ticks at 20 Hz ≈ 500 ms with no tool.
    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
    }, [cx, cy, lx, ly] as const);

    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        const ground = chunk.ground.blocks[idx];
        return !!ground && ground.kind === 4;
      },
      { cx, cy, lx, ly },
      { timeout: 5000 },
    );
    await page.waitForFunction(
      () =>
        window.__anarchy!.inventory.countOf(2) === 1 &&
        window.__anarchy!.inventory.countOf(4) === 9,
      undefined,
      { timeout: 5000 },
    );

    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    // Restore the natural Grass ground so later specs see the seeded
    // worldgen at (3, 0).
    await adminSetBlock(cx, cy, "ground", lx, ly, "grass").catch(() => {});
  }
});

test("held break: top-layer break does NOT fall through to ground without a release", async ({
  page,
}) => {
  // Task 500: holding LMB through a top-layer break must STOP there. A
  // common accident before this fix was holding to clear a torch and
  // accidentally digging up the grass underneath the same hold. The
  // server now arms a "needs release" latch on a top-break completion;
  // the resolver refuses the follow-on `GroundReplace` until the client
  // sends `BreakIntent { target: null }` (mouseup / cursor-off).
  //
  // Setup: torch top + grass ground at (3, 0). Default loadout has 10
  // Gold in slot 0 (`places_block = Gold`, `is_full`), so a ground-replace
  // resolution is normally available — making the "ground stays Grass"
  // assertion meaningful (otherwise the resolver would drop the intent
  // for lack of replacement, regardless of the latch).
  const cx = 0,
    cy = 0,
    lx = 3,
    ly = 0;
  await adminSetBlock(cx, cy, "ground", lx, ly, "grass");
  await adminSetBlock(cx, cy, "top", lx, ly, "torch");

  try {
    await page.goto(`/?username=torch-latch&color=0`);
    await page.waitForFunction(() => window.__anarchy !== undefined);
    await page.waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return false;
      return a.getLocalPlayerId() !== null && a.inventory.countOf(4) === 10;
    });
    // Both the seeded torch (client kind 23) and the grass ground (client
    // kind 1) must have round-tripped through the wire before we start
    // the hold. (Client BlockType numbers diverge from the server by +1
    // past Sticks because of the `Hidden` occlusion sentinel — see
    // `client/src/game/terrain.ts`.)
    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        const top = chunk.top.blocks[idx];
        const ground = chunk.ground.blocks[idx];
        return !!top && top.kind === 23 && !!ground && ground.kind === 1;
      },
      { cx, cy, lx, ly },
    );

    // Hold the break — kicks the heartbeat in for repeated wire-side
    // resends. Torch max_durability = 2 → ~100 ms at 20 Hz.
    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
    }, [cx, cy, lx, ly] as const);
    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        const top = chunk.top.blocks[idx];
        return !!top && top.kind === 0;
      },
      { cx, cy, lx, ly },
      { timeout: 5000 },
    );

    // The client is still "holding LMB" — keep heartbeating the same
    // target for ~1.5 s (>> grass max_durability = 5 ticks = 250 ms).
    // Without the latch the ground would have been swapped to Gold and a
    // Gold consumed; with the latch the cell must remain Grass and Gold
    // count must stay at 10. The heartbeat lives on a setInterval at
    // BREAK_HEARTBEAT_TICKS * INPUT_TICK_INTERVAL_MS in
    // bootstrap/break_place.ts, so just re-shipping the same intent
    // here gives the server multiple chances to roll into the ground.
    for (let i = 0; i < 8; i++) {
      await page.evaluate((coords) => {
        const [cx, cy, lx, ly] = coords;
        window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
      }, [cx, cy, lx, ly] as const);
      await page.waitForTimeout(200);
    }
    expect(
      await page.evaluate(
        ({ cx, cy, lx, ly }) => {
          const a = window.__anarchy!;
          const chunk = a.terrain.get(cx, cy)!;
          return chunk.ground.blocks[ly * 16 + lx]!.kind;
        },
        { cx, cy, lx, ly },
      ),
    ).toBe(1);
    expect(
      await page.evaluate(() => window.__anarchy!.inventory.countOf(4)),
    ).toBe(10);

    // Release + re-hold. The latch is cleared by the wire-side `null` and
    // the next Some(target) starts a fresh session that resolves as a
    // ground-replace — grass breaks in ~5 ticks (250 ms), the cell swaps
    // to Gold, and the breaker's Gold count drops by 1.
    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));
    await page.evaluate((coords) => {
      const [cx, cy, lx, ly] = coords;
      window.__anarchy!.sendBreakIntent({ cx, cy, lx, ly });
    }, [cx, cy, lx, ly] as const);
    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        const ground = chunk.ground.blocks[idx];
        return !!ground && ground.kind === 4;
      },
      { cx, cy, lx, ly },
      { timeout: 5000 },
    );
    await page.waitForFunction(
      () => window.__anarchy!.inventory.countOf(4) === 9,
      undefined,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    // Restore the natural worldgen at the test cell for downstream specs.
    await adminSetBlock(cx, cy, "top", lx, ly, "air").catch(() => {});
    await adminSetBlock(cx, cy, "ground", lx, ly, "grass").catch(() => {});
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
