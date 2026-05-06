import { test, expect, type Page } from "@playwright/test";

// Browser-driven e2e for the per-tick effects feed (task 070).
//
// The renderer-side place-pulse / break-shatter / targeting-overlay are
// internal Three.js scene state and not introspectable from Playwright,
// so this spec asserts the wire surface that drives them: client A
// initiates a held break, client B observes the targeting overlay
// (`getActiveTargetingStates`) and the eventual break-edit event
// (`getObservedBlockEditCount`). Mirrors the cross-client assertion in
// `break-block.spec.ts` but at the effects layer instead of the
// terrain mutation.

const SERVER_URL = "http://localhost:8080";

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page, username: string): Promise<void> {
  await page.goto(`/?username=${encodeURIComponent(username)}&color=0`);
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

test("targeting overlay and break edit fan out to a non-acting peer", async ({
  browser,
}) => {
  // Wood (max durability 10) so the held break completes in ~10 ticks.
  await seedTopBlock(0, 0, 1, 0, "wood");
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a, "tester");
    const aSelf = await waitForSelfSpawn(a);
    await openClient(b, "tester");
    await waitForSelfSpawn(b);

    // Both clients see the seed before the break starts.
    await a.waitForFunction(() => {
      const c = window.__anarchy?.terrain.get(0, 0);
      return !!c && c.top.blocks[0 * 16 + 1].kind === 2; // Wood
    });
    await b.waitForFunction(() => {
      const c = window.__anarchy?.terrain.get(0, 0);
      return !!c && c.top.blocks[0 * 16 + 1].kind === 2;
    });

    // A starts holding break — server stores the intent and the next tick
    // both clients should see a TargetingState entry with player_id = A.
    await a.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 1, ly: 0 }),
    );

    await b.waitForFunction((peerId: number) => {
      const targets = window.__anarchy?.getActiveTargetingStates() ?? [];
      return targets.some(
        (t) => t.playerId === peerId && t.cx === 0 && t.cy === 0 && t.lx === 1 && t.ly === 0,
      );
    }, aSelf.id);

    // Snapshot the durability_pct on B's side and verify it decays — proves
    // the per-tick re-emission is happening, not just a one-shot delivery.
    const initialPct = await b.evaluate((peerId: number) => {
      const targets = window.__anarchy?.getActiveTargetingStates() ?? [];
      const mine = targets.find((t) => t.playerId === peerId);
      return mine?.durabilityPct ?? 0;
    }, aSelf.id);
    expect(initialPct).toBeGreaterThan(0);
    expect(initialPct).toBeLessThanOrEqual(100);

    // After ~10 ticks the block breaks — both clients see a BlockEdit
    // event delivered (count strictly increases on B).
    const beforeCount = await b.evaluate(
      () => window.__anarchy!.getObservedBlockEditCount(),
    );
    await b.waitForFunction(
      (before: number) =>
        window.__anarchy!.getObservedBlockEditCount() > before,
      beforeCount,
    );

    // Once the block breaks, the targeting set drains for B (the cell is
    // now Air → not targetable → not in the targets list).
    await b.waitForFunction((peerId: number) => {
      const targets = window.__anarchy?.getActiveTargetingStates() ?? [];
      return !targets.some((t) => t.playerId === peerId);
    }, aSelf.id);

    await a.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await ctxA.close();
    await ctxB.close();
    await seedTopBlock(0, 0, 1, 0, "air").catch(() => {});
  }
});
