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

    // A sends a place via the wire seam — the server reads A's selected
    // hotbar slot (default 0, seeded with 10 Gold) and produces a Gold.
    await a.evaluate(() => {
      window.__anarchy!.sendPlaceBlock(0, 0, 2, 0);
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
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 10, 0));

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

test("ghost: visible over a valid cell when held slot is placeable; gone when slot is empty", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();

  try {
    await openClient(a);
    const self = await waitForSelfSpawn(a);
    // Single-client run: A spawns at (0, 0) without a peer to push it.
    if (self.x !== 0 || self.y !== 0) {
      throw new Error(
        `expected solo spawn at (0, 0), got (${self.x}, ${self.y})`,
      );
    }

    // No cursor → no ghost. Initial state on a fresh `runMain`.
    const initial = await a.evaluate(() =>
      window.__anarchy!.getGhostState(),
    );
    if (initial !== null) {
      throw new Error(`expected null ghost on fresh session, got ${JSON.stringify(initial)}`);
    }

    // Aim cursor right of the player. NDC (0.2, 0) lands in chunk (0, 0),
    // tiles 1..3 across realistic Playwright viewport aspects (≥ 1.0).
    // Default starter inventory has 10 Gold in slot 0 → ghost should
    // appear with kind = Gold (BlockType.Gold = 4).
    await a.evaluate(() =>
      window.__anarchy!.setCursorNdc({ x: 0.2, y: 0 }),
    );
    const ghost = await a
      .waitForFunction(() => {
        const g = window.__anarchy!.getGhostState();
        return g === null ? false : g;
      })
      .then((h) => h.jsonValue() as Promise<{ cell: number[]; kind: number }>);
    if (ghost.kind !== 4) {
      throw new Error(`expected ghost kind Gold (4), got ${ghost.kind}`);
    }
    if (ghost.cell[0] !== 0 || ghost.cell[1] !== 0) {
      throw new Error(
        `expected ghost in chunk (0, 0), got (${ghost.cell[0]}, ${ghost.cell[1]})`,
      );
    }

    // Switch to slot 8 (empty in the starter inventory) → ghost disappears.
    // Press Digit9 because the keymap binds digit `n` to slot `n-1`.
    await a.keyboard.press("Digit9");
    await a.waitForFunction(
      () => window.__anarchy!.getGhostState() === null,
    );

    // Switch back to slot 0 (10 Gold) → ghost reappears at the same cell.
    await a.keyboard.press("Digit1");
    await a.waitForFunction(() => {
      const g = window.__anarchy!.getGhostState();
      return g !== null && g.kind === 4;
    });
  } finally {
    await ctxA.close();
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
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 0, 0));

    await a.waitForTimeout(500);
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Air");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Air");
  } finally {
    await ctxA.close();
    await ctxB.close();
    await clearTopBlock(cx, cy, lx, ly);
  }
});
