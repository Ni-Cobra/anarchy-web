import { test, expect, type Page } from "./test-shared";

import { adminDamagePlayer, adminTeleport } from "./admin";

// Task 120 e2e: damage feedback (screen shake + HP bar flash). Covers:
//  - admin damage to the local player flashes the HP bar background white
//    and triggers a non-zero screen-shake offset, both clearing within the
//    decay window (~600 ms past the longest configured shake + flash).
//  - several wire ticks without any damage do NOT fire feedback — proves
//    the detection seam is strictly "HP went down" rather than "any HP
//    frame" (the server's admin damage endpoint rejects amount=0, so we
//    pin the inert-tick invariant by just waiting through several ticks).
//  - damage to a different player does NOT trigger the local feedback —
//    only HP loss the local viewer observes counts.

const SPAWN_TILE = { x: 0.5, y: 0.5 } as const;

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

async function shakeMagnitude(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const a = window.__anarchy;
    if (!a) return 0;
    const off = a.getScreenShakeOffset();
    return Math.hypot(off.dx, off.dy);
  });
}

async function isFlashing(page: Page): Promise<boolean> {
  return await page.evaluate(() => window.__anarchy!.isHpBarFlashing());
}

test("admin damage to the local player fires shake + flash and both clear", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "dmg-fb-local");
    await adminTeleport(me.id, SPAWN_TILE.x, SPAWN_TILE.y);

    // Wait for the HP bar to surface at full HP — the rAF detection seam
    // needs a baseline `lastSeenLocalHp` before any damage lands.
    await page.waitForFunction(() => {
      const text = document.querySelector(
        "#anarchy-hp-bar .anarchy-hp-text",
      )?.textContent;
      return text === "100 / 100";
    });
    // Pre-conditions: no shake, no flash.
    expect(await shakeMagnitude(page)).toBe(0);
    expect(await isFlashing(page)).toBe(false);

    const outcome = await adminDamagePlayer(me.id, 20);
    expect(outcome.kind).toBe("alive");

    // Both feedback effects fire within the first frame after the HP
    // snapshot lands. The default HP-flash duration is 150 ms and the
    // longest shake duration is 350 ms — give Playwright a comfortable
    // 500 ms window to observe at least one frame mid-effect.
    await page.waitForFunction(
      () => {
        const a = window.__anarchy;
        if (!a) return false;
        if (!a.isHpBarFlashing()) return false;
        const off = a.getScreenShakeOffset();
        return Math.hypot(off.dx, off.dy) > 0;
      },
      undefined,
      { timeout: 500 },
    );

    // After ~600 ms both should be quiet again (flash <= 150 ms, shake
    // <= 350 ms). Poll until clear.
    await page.waitForFunction(
      () => {
        const a = window.__anarchy;
        if (!a) return false;
        if (a.isHpBarFlashing()) return false;
        const off = a.getScreenShakeOffset();
        return Math.hypot(off.dx, off.dy) === 0;
      },
      undefined,
      { timeout: 1_500 },
    );
  } finally {
    await ctx.close();
  }
});

test("inert wire ticks never spuriously fire feedback", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "dmg-fb-quiet");
    await adminTeleport(me.id, SPAWN_TILE.x, SPAWN_TILE.y);

    // Wait for the bar to surface so the rAF detection seam has a
    // baseline `lastSeenLocalHp` of `MAX_PLAYER_HEALTH`.
    await page.waitForFunction(() => {
      const text = document.querySelector(
        "#anarchy-hp-bar .anarchy-hp-text",
      )?.textContent;
      return text === "100 / 100";
    });

    // Several server ticks (20 Hz) without any damage event must not
    // trip either feedback effect — proves the detection seam is
    // strictly "HP went down" and not "any HP frame".
    await page.waitForTimeout(600);
    expect(await isFlashing(page)).toBe(false);
    expect(await shakeMagnitude(page)).toBe(0);
    const hpText = await page.evaluate(
      () =>
        document.querySelector("#anarchy-hp-bar .anarchy-hp-text")?.textContent,
    );
    expect(hpText).toBe("100 / 100");
  } finally {
    await ctx.close();
  }
});

test("damage to a different player does NOT fire local feedback", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    const a = await openClient(pageA, "dmg-fb-a");
    const b = await openClient(pageB, "dmg-fb-b");
    await adminTeleport(a.id, 1.5, 0.5);
    await adminTeleport(b.id, 3.5, 0.5);

    // Wait for both HP bars to land at full.
    for (const p of [pageA, pageB]) {
      await p.waitForFunction(() => {
        const text = document.querySelector(
          "#anarchy-hp-bar .anarchy-hp-text",
        )?.textContent;
        return text === "100 / 100";
      });
    }

    // Damage B only; A must NOT flash or shake.
    const outcome = await adminDamagePlayer(b.id, 50);
    expect(outcome.kind).toBe("alive");

    // Wait long enough that B's feedback would have fired and cleared,
    // then assert A stayed quiet the whole time.
    await pageA.waitForTimeout(600);
    expect(await isFlashing(pageA)).toBe(false);
    expect(await shakeMagnitude(pageA)).toBe(0);
    const aHpText = await pageA.evaluate(
      () =>
        document.querySelector("#anarchy-hp-bar .anarchy-hp-text")?.textContent,
    );
    expect(aHpText).toBe("100 / 100");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
