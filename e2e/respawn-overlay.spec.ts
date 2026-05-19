import { test, expect, type Page } from "./test-shared";

import { adminDamagePlayer, adminTeleport } from "./admin";

// Task 160 e2e: respawn overlay. The server emits a per-tick
// `PlayerDeathEvent` at the same tick the local player's HP first
// crosses zero; the client triggers a full-screen black overlay with a
// large red "You died" title, then fades the two elements over
// independent 4 s / 8 s timelines.

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page, username: string): Promise<SelfView> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
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
    .then((h) => h.jsonValue() as Promise<SelfView>);
}

test("local death triggers the overlay; black fades over 4 s, title over 8 s", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "resp-overlay-1");
    await adminTeleport(me.id, 0.5, 0.5);

    // Overlay starts hidden.
    const initial = await page.evaluate(() =>
      window.__anarchy!.getDeathOverlayState(),
    );
    expect(initial.visible).toBe(false);

    // One-hit kill via admin damage. Server emits PlayerDeathEvent, then
    // the same-tick respawn lands the player back at full HP at the
    // spawn tile.
    const outcome = await adminDamagePlayer(me.id, 100);
    expect(outcome.kind).toBe("killed");

    // Overlay becomes visible within ~100 ms of the event arriving.
    await page.waitForFunction(
      () => {
        const s = window.__anarchy!.getDeathOverlayState();
        return s.visible && s.blackOpacity > 0.9 && s.titleOpacity > 0.9;
      },
      undefined,
      { timeout: 1_500 },
    );

    // DOM presence: the title element carries "You died" and the
    // assertive aria-live announcement.
    const title = page.locator(
      "#anarchy-death-overlay .anarchy-death-title",
    );
    await expect(title).toHaveText("You died");
    await expect(title).toHaveAttribute("aria-live", "assertive");

    // Black layer fades over 4 s.
    await page.waitForFunction(
      () => {
        const s = window.__anarchy!.getDeathOverlayState();
        return s.visible && s.blackOpacity < 0.05;
      },
      undefined,
      { timeout: 5_000 },
    );

    // Title stays visible past the black layer's fade, then both clear.
    await page.waitForFunction(
      () => {
        const s = window.__anarchy!.getDeathOverlayState();
        return !s.visible && s.titleOpacity === 0 && s.blackOpacity === 0;
      },
      undefined,
      { timeout: 6_000 },
    );
  } finally {
    await ctx.close();
  }
});

test("other players dying does not show the overlay locally", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "resp-other-a");
    const meB = await openClient(b, "resp-other-b");
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);

    // A sees B in their world before we kill B (so A's chunk would
    // carry B's snapshot if filtering somehow leaked).
    await a.waitForFunction(
      (id: number) => window.__anarchy!.world.getPlayer(id) !== undefined,
      meB.id,
    );

    // Kill B. B's overlay should fire; A's should remain hidden.
    const outcome = await adminDamagePlayer(meB.id, 100);
    expect(outcome.kind).toBe("killed");

    await b.waitForFunction(
      () => window.__anarchy!.getDeathOverlayState().visible,
      undefined,
      { timeout: 1_500 },
    );

    // Give A a moment past the event tick — the per-receiver compose
    // filter must drop B's event before it reaches A. Poll briefly to
    // catch any leaked trigger.
    const aSawOverlay = await a.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        if (window.__anarchy!.getDeathOverlayState().visible) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    });
    expect(aSawOverlay).toBe(false);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
