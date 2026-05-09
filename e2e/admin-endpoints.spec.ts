import { test, expect, type Page } from "@playwright/test";
import {
  AdminItemId,
  adminGiveItem,
  adminSetBlock,
  adminTeleport,
} from "./admin";

// Task 110 e2e: cover the testing-mode admin endpoints end-to-end + the
// terrain-mutation-fanout-to-second-client gap from the task's coverage
// review. Each spec opens two browser contexts so we exercise the
// per-client `TickUpdate` fan-out (ADR 0003) — chunk-dirty bits set by
// the admin handlers must flow to *both* connected clients on the next
// tick, regardless of which client triggered the admin call.
//
// These specs lean on the `--testing` server in `playwright.config.ts`;
// each helper would 404 against a non-testing server.

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

async function waitForTopBlockKind(
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
      return !!block && block.kind === expected;
    },
    { cx, cy, lx, ly, expected },
  );
}

test("admin set-block fans out to a second connected client", async ({
  browser,
}) => {
  // Two browser contexts so the server fan-out path (ADR 0003 per-client
  // TickUpdate composition) is the one being exercised, not just the
  // single-client read-back. The chosen cell sits inside the test-clear
  // spawn region so worldgen never overwrites it.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const cx = 0;
  const cy = 0;
  const lx = 4;
  const ly = 4;

  try {
    await openClient(a, "admin-fanout-a");
    await openClient(b, "admin-fanout-b");

    // Both clients should see Air to start (test-clear spawn region).
    await waitForTopBlockKind(a, cx, cy, lx, ly, 0);
    await waitForTopBlockKind(b, cx, cy, lx, ly, 0);

    // Plant a Stone via the admin endpoint. Neither client *did* the
    // mutation — proving the per-client compose ships the dirty chunk to
    // both regardless of authorship.
    await adminSetBlock(cx, cy, "top", lx, ly, "stone");

    // BlockType.Stone === 3 in both client + server enums.
    await waitForTopBlockKind(a, cx, cy, lx, ly, 3);
    await waitForTopBlockKind(b, cx, cy, lx, ly, 3);

    // Flip back to Air so the next spec doesn't inherit the seeded cell.
    await adminSetBlock(cx, cy, "top", lx, ly, "air");
    await waitForTopBlockKind(a, cx, cy, lx, ly, 0);
    await waitForTopBlockKind(b, cx, cy, lx, ly, 0);
  } finally {
    await ctxA.close();
    await ctxB.close();
    await adminSetBlock(cx, cy, "top", lx, ly, "air").catch(() => {});
  }
});

test("admin give-item drops items into the recipient inventory", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "admin-give");

    // Inventory cell currently holds 10 Gold (starter loadout's first slot,
    // packed by `try_add` after the tools take their fixed slots). Plant
    // 5 more Stone via the admin endpoint; the wire flow flips the dirty
    // bit and the next InventoryUpdate carries the new pooled count.
    await adminGiveItem(me.id, AdminItemId.Stone, 5);

    await page.waitForFunction(() => {
      const inv = window.__anarchy!.inventory;
      // ItemId.Stone === 3 numerically.
      return inv.countOf(3) >= 5;
    });
  } finally {
    await ctx.close();
  }
});

test("admin teleport-player moves the player and is visible to a second client", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    const meA = await openClient(a, "admin-tp-a");
    await openClient(b, "admin-tp-b");

    // Teleport A a few tiles east. Confirm both A's local mirror and B's
    // remote-player view land at the new position (server is the source
    // of truth on positions; the snapshot buffer's interpolation delay
    // means we wait for both to converge rather than asserting an exact
    // tick).
    const targetX = 5.5;
    const targetY = 0.5;
    await adminTeleport(meA.id, targetX, targetY);

    await a.waitForFunction(
      ({ id, tx, ty }) => {
        const me = window.__anarchy!.world.getPlayer(id);
        return !!me && Math.abs(me.x - tx) < 0.6 && Math.abs(me.y - ty) < 0.6;
      },
      { id: meA.id, tx: targetX, ty: targetY },
    );

    await b.waitForFunction(
      ({ id, tx, ty }) => {
        const them = window.__anarchy!.world.getPlayer(id);
        return (
          !!them && Math.abs(them.x - tx) < 0.6 && Math.abs(them.y - ty) < 0.6
        );
      },
      { id: meA.id, tx: targetX, ty: targetY },
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("admin endpoints reach the ground layer too (sanity)", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cx = 0;
  const cy = 0;
  const lx = 6;
  const ly = 6;
  try {
    await openClient(page, "admin-ground");

    // Plant Stone on the *ground* layer (the existing `/debug/seed-top-block`
    // endpoint can't do this — `/admin/set-block` is strictly more capable).
    // The chunk goes dirty, the next tick ships it, and the client mirror
    // has Stone at the cell's ground slot.
    await adminSetBlock(cx, cy, "ground", lx, ly, "stone");

    await page.waitForFunction(
      ({ cx, cy, lx, ly }) => {
        const a = window.__anarchy;
        if (!a) return false;
        const chunk = a.terrain.get(cx, cy);
        if (!chunk) return false;
        const idx = ly * 16 + lx;
        // BlockType.Stone === 3.
        return chunk.ground.blocks[idx]?.kind === 3;
      },
      { cx, cy, lx, ly },
    );

    // Reset to Grass (worldgen default for the spawn region's ground layer).
    await adminSetBlock(cx, cy, "ground", lx, ly, "grass");
  } finally {
    await ctx.close();
    await adminSetBlock(cx, cy, "ground", lx, ly, "grass").catch(() => {});
  }
});

test("the e2e save file is never written (testing mode is on)", async ({
  browser,
}) => {
  // Acceptance check from the task: "No spec writes into the on-disk
  // world." Drive an admin set-block, then assert that POST /debug/save
  // returns the testing-mode short-circuit (409). This pins the contract
  // that the harness is genuinely save-disabled — a future config-edit
  // that drops `--testing` would surface here as a 200 from /debug/save.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await openClient(page, "save-gate");
    await adminSetBlock(0, 0, "top", 7, 7, "stone");
    const res = await fetch("http://localhost:8080/debug/save", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    await adminSetBlock(0, 0, "top", 7, 7, "air");
  } finally {
    await ctx.close();
    await adminSetBlock(0, 0, "top", 7, 7, "air").catch(() => {});
  }
});
