import { test, type Page } from "@playwright/test";

// Browser-driven e2e for the top-layer block placement flow (builder mode).
// Builder-mode toggling, the gold ghost preview, and the right-click trigger
// are client-only state — the server only sees a `PlaceBlock` message.
// Spec covers:
//   1. The wire round-trip: A toggles builder mode, sends a place at a known
//      cell; both A and B see the gold block on the next tick.
//   2. Server validation: an out-of-reach place is silently dropped.
//   3. Server validation: placing on a cell where another player stands is
//      silently dropped.

const SERVER_URL = "http://localhost:8080";
const CHUNK_SIZE = 16;

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

async function clearTopBlock(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): Promise<void> {
  const url = `${SERVER_URL}/debug/seed-top-block/${cx}/${cy}/${lx}/${ly}/air`;
  await fetch(url, { method: "POST" }).catch(() => {});
}

async function waitForTopBlockKind(
  page: Page,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kindName: "Air" | "Grass" | "Wood" | "Stone" | "Gold",
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
      // Numeric BlockType enum: Air=0, Grass=1, Wood=2, Stone=3, Gold=4.
      const expected =
        kindName === "Air"
          ? 0
          : kindName === "Grass"
            ? 1
            : kindName === "Wood"
              ? 2
              : kindName === "Stone"
                ? 3
                : 4;
      return block.kind === expected;
    },
    { cx, cy, lx, ly, kindName },
  );
}

test("place: A toggles builder + sends → both clients see gold", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // Target chunk (0, 0), local (2, 0) — center (2.5, 0.5). With two clients
  // spawning at origin the player↔player push (circle-circle, radius
  // PLAYER_RADIUS = 0.35) shoves the lower-id placer A to (-0.35, 0);
  // reach to the target is √(2.85² + 0.5²) ≈ 2.89 — comfortably in. (Tile
  // (3, 0) is also in reach now from this slightly-closer post-push spot:
  // √(3.85² + 0.5²) ≈ 3.88 < 4.0; the 4.0 reach bound is independent of
  // the hitbox size.)
  const cx = 0,
    cy = 0,
    lx = 2,
    ly = 0;

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    // Cell is Air to start (placeholder worldgen leaves the top empty).
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Air");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Air");

    // A toggles builder mode and sends a place. The wire-level handle is
    // the same code path the right-click handler runs through.
    await a.evaluate(() => window.__anarchy!.setBuilderMode(true));
    await a.evaluate(() => {
      // Numeric BlockType enum, Gold = 4.
      window.__anarchy!.sendPlaceBlock(0, 0, 2, 0, 4);
    });

    // Both clients should observe Gold at the cell after the next tick.
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Gold");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Gold");
  } finally {
    await ctxA.close();
    await ctxB.close();
    // Defensive cleanup so later specs that walk through chunk (0, 0)
    // aren't perturbed.
    await clearTopBlock(cx, cy, lx, ly);
  }
});

test("place: server silently drops out-of-reach PlaceBlock", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // Tile (10, 0) center (10.5, 0.5) → distance ≈ 10 from origin — way past
  // REACH_BLOCKS = 4. Server must silently reject.
  const cx = 0,
    cy = 0,
    lx = 10,
    ly = 0;

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    await waitForTopBlockKind(a, cx, cy, lx, ly, "Air");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Air");

    // Bypass the client-side reach gate by calling the wire helper directly.
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 10, 0, 4));

    // Several tick cycles — way more than enough for any mutation to
    // propagate. The cell must still be Air on both clients.
    await a.waitForTimeout(500);
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Air");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Air");
  } finally {
    await ctxA.close();
    await ctxB.close();
    // Defensive cleanup just in case (no-op if already Air).
    await clearTopBlock(cx, cy, lx, ly);
  }
});

test("place: server silently drops PlaceBlock on a cell occupied by a player", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // Both clients spawn at origin; the circle-circle push shoves the
  // lower-id (A) to (-0.35, 0) and the higher-id (B) to (+0.35, 0). The
  // cell at world tile (0, 0) ([0,1]×[0,1]) is overlapped by B's circle
  // (B's center sits exactly on the cell's south edge, distance 0 < r).
  // Placing into it must be rejected by the server.
  const cx = 0,
    cy = 0,
    lx = 0,
    ly = 0;

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    await waitForSelfSpawn(b);

    await waitForTopBlockKind(a, cx, cy, lx, ly, "Air");

    // A asks the server to place on the cell B is standing on.
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 0, 0, 4));

    await a.waitForTimeout(500);
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Air");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Air");
  } finally {
    await ctxA.close();
    await ctxB.close();
    await clearTopBlock(cx, cy, lx, ly);
  }
});
