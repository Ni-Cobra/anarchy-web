import { test, expect, type Page } from "@playwright/test";

// Browser-driven e2e: load index.html via the dev server, let `src/main.ts`
// run the real WebSocket + wire + world stack, and assert against the
// `window.__anarchy` test handle the app exposes for this purpose.
//
// Protocol-level invariants are already pinned by the Node-side specs
// (connection / spawn-despawn / tick-loop / validation). The point of this
// file is to exercise the *browser entry path* — that index.html + main.ts
// + the wire bridge actually wire together end-to-end in a real browser.

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__anarchy !== undefined);
}

async function waitForSelfSpawn(page: Page): Promise<SelfView> {
  return await page.waitForFunction(() => {
    const a = window.__anarchy;
    if (!a) return null;
    const id = a.getLocalPlayerId();
    if (id === null || id === 0) return null;
    const me = a.world.getPlayer(id);
    if (!me) return null;
    return { id: me.id, x: me.x, y: me.y };
  }).then((handle) => handle.jsonValue() as Promise<SelfView>);
}

test("a fresh client connects, spawns, and sees itself in the world", async ({ page }) => {
  await openClient(page);
  const me = await waitForSelfSpawn(page);
  expect(me.id).toBeGreaterThan(0);
  expect(me.x).toBe(0);
  expect(me.y).toBe(0);
});

test("two browser clients each see the other in their world", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    const meA = await waitForSelfSpawn(a);

    await openClient(b);
    const meB = await waitForSelfSpawn(b);

    // A's world should eventually contain B (B spawned after A, so a tick
    // snapshot must arrive on A's socket carrying B). And vice versa.
    await a.waitForFunction((peerId) => {
      return window.__anarchy?.world.getPlayer(peerId) !== undefined;
    }, meB.id);
    await b.waitForFunction((peerId) => {
      return window.__anarchy?.world.getPlayer(peerId) !== undefined;
    }, meA.id);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("one client moves and the other observes the move", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    const meA = await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    // Wait for B to see A at the origin first, so we know the two worlds
    // are in sync before A moves.
    await b.waitForFunction((peerId) => {
      const p = window.__anarchy?.world.getPlayer(peerId);
      return p !== undefined && p.x === 0 && p.y === 0;
    }, meA.id);

    // A pushes a single MoveIntent east. The server stores it and starts
    // advancing A's position each tick; B observes the eastward motion via
    // the StateUpdate broadcasts.
    await a.evaluate(() => window.__anarchy!.sendMoveIntent(1, 0));

    await b.waitForFunction((peerId) => {
      const p = window.__anarchy?.world.getPlayer(peerId);
      return p !== undefined && p.x > 0 && p.y === 0;
    }, meA.id);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("when one client disconnects the other sees them leave the world", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    const meA = await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    // Confirm B sees A first, then drop A.
    await b.waitForFunction((peerId) => {
      return window.__anarchy?.world.getPlayer(peerId) !== undefined;
    }, meA.id);

    await ctxA.close();

    // PlayerDespawned (or the next snapshot) should remove A from B's world.
    await b.waitForFunction((peerId) => {
      return window.__anarchy?.world.getPlayer(peerId) === undefined;
    }, meA.id);
  } finally {
    await ctxB.close();
    // ctxA may already be closed; closing again is a no-op error we ignore.
    await ctxA.close().catch(() => {});
  }
});
