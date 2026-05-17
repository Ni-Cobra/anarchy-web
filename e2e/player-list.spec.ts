import { test, expect, type Page } from "./test-shared";

// Task 170 e2e: the player-list HUD badge displays `N / MAX_PLAYERS`,
// hovering it reveals the dropdown listing every connected player, and
// the count updates on join/leave within a couple of ticks (the server
// broadcasts a `ConnectedPlayersList` on every admission and disconnect).

const HUD_BADGE_SELECTOR = "#anarchy-player-list-badge .anarchy-player-list-label";
const HUD_ROOT_SELECTOR = "#anarchy-player-list-hud";
const HUD_ROWS_SELECTOR = "#anarchy-player-list-dropdown li";

async function openClient(page: Page, username: string): Promise<{ id: number }> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      if (id === null || id === 0) return null;
      return { id };
    })
    .then((h) => h.jsonValue() as Promise<{ id: number }>);
}

async function waitForBadge(page: Page): Promise<string> {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel as string);
    const t = (el?.textContent ?? "").trim();
    return /^\d+ \/ \d+$/.test(t);
  }, HUD_BADGE_SELECTOR);
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel as string);
    return (el?.textContent ?? "").trim();
  }, HUD_BADGE_SELECTOR);
}

async function readDropdownRows(page: Page): Promise<string[]> {
  return await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map(
      (li) => li.textContent?.trim() ?? "",
    );
  }, HUD_ROWS_SELECTOR);
}

async function openDropdown(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    el.dispatchEvent(new Event("mouseenter"));
  }, HUD_ROOT_SELECTOR);
}

test("player-list HUD reflects the local roster on welcome", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await openClient(page, "roster-solo");
    const label = await waitForBadge(page);
    // Other concurrent specs may push the count above 1, but the cap
    // ships as 32 and there is always at least one (us).
    expect(label).toMatch(/^\d+ \/ 32$/);
    const leading = Number(label.match(/^(\d+) \/ \d+$/)![1]);
    expect(leading).toBeGreaterThanOrEqual(1);

    await openDropdown(page);
    const isOpen = await page.evaluate((sel) => {
      return document.querySelector(sel)?.classList.contains("open") ?? false;
    }, HUD_ROOT_SELECTOR);
    expect(isOpen).toBe(true);

    const rows = await readDropdownRows(page);
    const self = rows.find((r) => r.includes("(you)"));
    expect(self).toBeDefined();
    expect(self).toContain("roster-solo");
  } finally {
    await ctx.close();
  }
});

test("player-list dropdown reflects a peer joining and leaving", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    await openClient(pageA, "roster-host");
    await waitForBadge(pageA);

    await openClient(pageB, "roster-peer");

    // Within ~10 ticks (500 ms) the join broadcast lands on A. Drive the
    // assertion off the peer's username appearing in A's dropdown rows —
    // robust against the exact baseline count (other concurrent specs
    // may add or drop players from the same shared server during a run).
    await pageA.waitForFunction(
      () => {
        const items = Array.from(
          document.querySelectorAll("#anarchy-player-list-dropdown li"),
        );
        return items.some((li) => (li.textContent ?? "").includes("roster-peer"));
      },
      undefined,
      { timeout: 10_000 },
    );

    // B disconnects; the next broadcast removes them from A's dropdown.
    await pageB.evaluate(() => window.__anarchy?.stop());

    await pageA.waitForFunction(
      () => {
        const items = Array.from(
          document.querySelectorAll("#anarchy-player-list-dropdown li"),
        );
        return !items.some((li) => (li.textContent ?? "").includes("roster-peer"));
      },
      undefined,
      { timeout: 10_000 },
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
