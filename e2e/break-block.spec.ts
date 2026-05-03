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

test("destroy: A clicks → block disappears for both A and B on the next tick", async ({
  browser,
}) => {
  // Seed BEFORE either client connects so both clients' first TickUpdate
  // already carries the block (avoids racing the chunk-dirty machinery
  // against late connects).
  //
  // Block at world tile (1, 0) — chunk (0, 0) local (1, 0). With two
  // clients spawning at origin the circle-circle push shoves the lower-id
  // player to (-0.35, 0) on the first joint tick, so the chosen block
  // must stay in reach from there: distance from (-0.35, 0) to tile
  // center (1.5, 0.5) is √(1.85² + 0.5²) ≈ 1.92 — comfortably under 4.0.
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

    // Both clients must see the seeded Wood block before the destroy.
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Wood");
    await waitForTopBlockKind(b, 0, 0, 1, 0, "Wood");

    // A sends BreakBlock for the cell. (We bypass the mousedown handler
    // because the picker is camera/cursor-driven and would require careful
    // coordinate setup; the wire-level handle does the same thing.)
    await a.evaluate(() => window.__anarchy!.sendBreakBlock(0, 0, 1, 0));

    // After one tick the chunk should ship as full-state with the cell
    // cleared. Both clients should see Air at (0, 0)/(1, 0).
    await waitForTopBlockKind(a, 0, 0, 1, 0, "Air");
    await waitForTopBlockKind(b, 0, 0, 1, 0, "Air");
  } finally {
    await ctxA.close();
    await ctxB.close();
    // Defensive cleanup if the destroy assertion failed: clear the seed so
    // later specs that walk through chunk (0, 0) aren't perturbed.
    await seedTopBlock(0, 0, 1, 0, "air").catch(() => {});
  }
});

test("destroy: server silently drops out-of-reach BreakBlock", async ({
  browser,
}) => {
  // Seed a block well outside REACH_BLOCKS = 4 from origin but inside chunk
  // (0, 0) so it's always loaded (view-radius and the four startup defaults
  // both keep this chunk loaded regardless of which clients are around).
  // World tile (10, 0) center (10.5, 0.5) → distance ≈ 10 from any
  // post-push player position (worst case ±PLAYER_RADIUS). Way outside reach.
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

    // A sends BreakBlock for the out-of-reach cell. Server validates against
    // A's authoritative position (still ≈ origin) and silently drops it.
    await a.evaluate(() => window.__anarchy!.sendBreakBlock(0, 0, 10, 0));

    // Give the server several tick cycles — way more than enough for any
    // mutation to propagate. The block must still be present.
    await a.waitForTimeout(500);
    await waitForTopBlockKind(a, 0, 0, 10, 0, "Wood");
    await waitForTopBlockKind(b, 0, 0, 10, 0, "Wood");
  } finally {
    await ctxA.close();
    await ctxB.close();
    // The server is reused across tests; clear the seeded block so it
    // doesn't perturb later specs that move clients through chunk (0, 0).
    await seedTopBlock(0, 0, 10, 0, "air").catch(() => {});
  }
});
