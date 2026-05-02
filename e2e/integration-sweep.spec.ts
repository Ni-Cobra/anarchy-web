import { test, expect, type Page } from "@playwright/test";

// Cross-cutting integration sweep for the destruction / placement / collision
// stack. The single-feature specs (`break-block.spec.ts`, `place-block.spec.ts`)
// pin the wire round-trips on their own; this file pins the cases that only
// surface when those features compose:
//
//   1. A places gold → B walks into the new block → B stops flush against it
//      on the next tick (collision picks up the just-placed state).
//   2. Peer occupancy lifts: while B stands on a target cell, A's
//      `canPlaceAt` gate AND the server agree the place is forbidden; once B
//      walks off, both flip to allowed and the place lands.
//   3. Reach-edge while moving: the server validates against its
//      authoritative post-tick position, not the client's view — a place at
//      a target that started in reach but slid past `REACH_BLOCKS` mid-walk
//      is rejected, world unchanged.
//   4. Builder-mode toggle after reconnect: a fresh page reload re-handshakes
//      the connection (fresh Welcome, new player id); a `PlaceBlock` issued
//      immediately after the reload is processed correctly and the second
//      client sees the block — the server isn't confused by an action
//      arriving in the same window as Welcome.
//
// All client-visible cell observations go through `__anarchy.terrain`; player
// positions through `__anarchy.world`. The same handle that the single-
// feature specs use, no privileged wire access.

const SERVER_URL = "http://localhost:8080";

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

async function readTopBlockKind(
  page: Page,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): Promise<number | null> {
  return await page.evaluate(
    ({ cx, cy, lx, ly }) => {
      const a = window.__anarchy;
      if (!a) return null;
      const chunk = a.terrain.get(cx, cy);
      if (!chunk) return null;
      return chunk.top.blocks[ly * 16 + lx]?.kind ?? null;
    },
    { cx, cy, lx, ly },
  );
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

test("place blocks B's path: B walks east into the new block and stops flush against it", async ({
  browser,
}) => {
  // Setup: both clients spawn at origin; the circle-circle push leaves
  // A (lower id) at (-r, 0) and B (higher id) at (+r, 0) where
  // r = PLAYER_RADIUS = 0.35. A places gold at world tile (2, 0) —
  // center (2.5, 0.5) — comfortably within reach. The block's left edge
  // sits at world x=2, so B walking east stops with center tangent to
  // it: x = 2 - r = 1.65.
  test.setTimeout(15_000);
  const cx = 0,
    cy = 0,
    lx = 2,
    ly = 0;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    const meB = await waitForSelfSpawn(b);

    // A places. Both clients must observe the gold cell before B starts
    // walking — otherwise the test could time-race the place vs. the move.
    await a.evaluate(() => window.__anarchy!.setBuilderMode(true));
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 2, 0, 4));
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Gold");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Gold");

    // B walks east continuously. The intent persists on the server until
    // changed; one send is enough.
    await b.evaluate(() => window.__anarchy!.sendMoveIntent(1, 0));

    // B must end up clamped at center x ≈ 1.65 (= 2 - PLAYER_RADIUS) ± ε.
    // We wait for the collision-clamped state, then assert the position is
    // stable across a few ticks (~150 ms ≈ 3 ticks at 20 Hz) so a
    // transient mid-step sample doesn't pass falsely.
    await b.waitForFunction(
      (peerId) => {
        const me = window.__anarchy?.world.getPlayer(peerId);
        return me !== undefined && me.x <= 1.7 && me.x >= 1.6;
      },
      meB.id,
      { timeout: 8_000 },
    );

    const x1 = await b.evaluate((peerId) => {
      return window.__anarchy!.world.getPlayer(peerId)!.x;
    }, meB.id);
    await b.waitForTimeout(200);
    const x2 = await b.evaluate((peerId) => {
      return window.__anarchy!.world.getPlayer(peerId)!.x;
    }, meB.id);
    // Stable within a tiny tolerance — the server should be repeatedly
    // dropping the eastward step once the circle is tangent.
    expect(Math.abs(x2 - x1)).toBeLessThan(0.05);
    expect(x2).toBeLessThanOrEqual(1.7);
    expect(x2).toBeGreaterThanOrEqual(1.6);

    // A's view of B should agree (ignore exact equality — the snapshot
    // buffer interpolates — but the world-mirror should be in the same
    // ballpark).
    const aSeesB = await a.evaluate((peerId) => {
      return window.__anarchy!.world.getPlayer(peerId)?.x ?? null;
    }, meB.id);
    expect(aSeesB).not.toBeNull();
    expect(aSeesB!).toBeLessThanOrEqual(1.75);
  } finally {
    // Stop B before leaving so the next test starts from rest.
    await b.evaluate(() => window.__anarchy?.sendMoveIntent(0, 0)).catch(() => {});
    await ctxA.close();
    await ctxB.close();
    await clearTopBlock(cx, cy, lx, ly);
  }
});

test("ghost gate + server agree: B on cell forbids place; B walks off, place lands", async ({
  browser,
}) => {
  // Both clients spawn at origin; the push lands A at (-r, 0), B at
  // (+r, 0) where r = PLAYER_RADIUS = 0.35. B's circle (center (0.35, 0),
  // radius 0.35) overlaps cell (0, 0) [0,1]×[0,1]: the nearest point on
  // the cell to B's center is the center itself, distance 0 < r. A is
  // tangent to the cell (nearest point (0, 0), distance r) and so does
  // not block placement. The server must reject A's place; the client
  // `canPlaceAt` gate must return false for the same reason. Once B
  // walks east past x = 1 + r = 1.35, B's circle clears cell (0, 0) and
  // both flip to allowed.
  test.setTimeout(15_000);
  const cx = 0,
    cy = 0,
    lx = 0,
    ly = 0;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(a);
    await waitForSelfSpawn(a);
    await openClient(b);
    const meB = await waitForSelfSpawn(b);

    // Wait for the post-push positions to be reflected in A's world so
    // canPlaceAt's overlap check sees B at (+r, 0). r = PLAYER_RADIUS = 0.35.
    await a.waitForFunction(
      (peerId) => {
        const p = window.__anarchy?.world.getPlayer(peerId);
        return p !== undefined && p.x > 0.3;
      },
      meB.id,
    );

    await a.evaluate(() => window.__anarchy!.setBuilderMode(true));

    // Step 1: gate says no while B stands on the cell.
    expect(await a.evaluate(() => window.__anarchy!.canPlaceAt(0, 0, 0, 0))).toBe(false);

    // Step 2: server agrees — a forced send (bypassing the gate) is dropped.
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 0, 0, 4));
    await a.waitForTimeout(300);
    expect(await readTopBlockKind(a, cx, cy, lx, ly)).toBe(0); // Air
    expect(await readTopBlockKind(b, cx, cy, lx, ly)).toBe(0);

    // Step 3: B walks east until past x = 1 + PLAYER_RADIUS = 1.35,
    // clearing B's circle from cell (0, 0). We wait a bit further (1.55)
    // for headroom against snapshot interpolation.
    await b.evaluate(() => window.__anarchy!.sendMoveIntent(1, 0));
    await a.waitForFunction(
      (peerId) => {
        const p = window.__anarchy?.world.getPlayer(peerId);
        return p !== undefined && p.x > 1.55;
      },
      meB.id,
      { timeout: 8_000 },
    );
    await b.evaluate(() => window.__anarchy!.sendMoveIntent(0, 0));

    // Step 4: gate flips to allowed.
    await a.waitForFunction(() => window.__anarchy!.canPlaceAt(0, 0, 0, 0));

    // Step 5: place lands.
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 0, 0, 4));
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Gold");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Gold");
  } finally {
    await b.evaluate(() => window.__anarchy?.sendMoveIntent(0, 0)).catch(() => {});
    await ctxA.close();
    await ctxB.close();
    await clearTopBlock(cx, cy, lx, ly);
  }
});

test("reach-edge while moving: target slides past REACH_BLOCKS mid-step → server rejects, world unchanged", async ({
  browser,
}) => {
  // Single client (no peer push). A spawns at (0, 0). The target cell
  // (3, 0) — center (3.5, 0.5) — is initially in reach: distance ≈ 3.54.
  // A walks west; once A's authoritative position is past x ≈ -0.55,
  // distance to the target exceeds REACH_BLOCKS (√(4.05² + 0.5²) ≈ 4.08).
  // We send the place AFTER waiting for the server-confirmed position to
  // cross that threshold so the rejection is deterministic.
  test.setTimeout(15_000);
  const cx = 0,
    cy = 0,
    lx = 3,
    ly = 0;

  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();

  try {
    await openClient(a);
    const meA = await waitForSelfSpawn(a);

    // Pin the starting condition: cell is Air, gate allows place from origin.
    expect(await readTopBlockKind(a, cx, cy, lx, ly)).toBe(0);
    expect(await a.evaluate(() => window.__anarchy!.canPlaceAt(0, 0, 3, 0))).toBe(true);

    // Walk west until past reach. SPEED * dt = 5 * 0.05 = 0.25 per tick;
    // ~3 ticks of westward drift reach x ≈ -0.75, just past the reach edge.
    await a.evaluate(() => window.__anarchy!.sendMoveIntent(-1, 0));
    await a.waitForFunction(
      (selfId) => {
        const me = window.__anarchy?.world.getPlayer(selfId);
        // distance to (3.5, 0.5) > REACH_BLOCKS = 4.0.
        if (!me) return false;
        const dx = 3.5 - me.x;
        const dy = 0.5 - me.y;
        return dx * dx + dy * dy > 4.0 * 4.0;
      },
      meA.id,
      { timeout: 8_000 },
    );
    // Stop moving so the test isn't racing against further drift.
    await a.evaluate(() => window.__anarchy!.sendMoveIntent(0, 0));

    // Both the client gate and the server should reject from here.
    expect(await a.evaluate(() => window.__anarchy!.canPlaceAt(0, 0, 3, 0))).toBe(false);
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 3, 0, 4));

    // Several tick cycles — way more than enough for any place to propagate.
    await a.waitForTimeout(400);
    expect(await readTopBlockKind(a, cx, cy, lx, ly)).toBe(0);
  } finally {
    await ctxA.close();
    await clearTopBlock(cx, cy, lx, ly);
  }
});

test("PlaceBlock issued right after a fresh reconnect Welcome is processed correctly and B sees it", async ({
  browser,
}) => {
  // Reconnect path: A connects, lives a moment, then `page.reload()` drops
  // the WebSocket and reopens it. The server allocates a fresh player id on
  // the new connection — no resume semantics. Builder-mode is client-only
  // state and resets on reload to `false`. A immediately re-toggles builder,
  // sends a `PlaceBlock`, and the server should accept it without confusion
  // even though the action arrives in the very next tick after Welcome.
  test.setTimeout(20_000);
  const cx = 0,
    cy = 0,
    lx = 1,
    ly = 1;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await openClient(b);
    await waitForSelfSpawn(b);

    await openClient(a);
    const firstA = await waitForSelfSpawn(a);

    // Reload A. New connection ⇒ new welcome ⇒ new player id.
    await a.reload();
    await a.waitForFunction(() => window.__anarchy !== undefined);
    const secondA = await waitForSelfSpawn(a);
    expect(secondA.id).not.toBe(firstA.id);
    // Builder mode must have reset (client-only state).
    expect(await a.evaluate(() => window.__anarchy!.isBuilderMode())).toBe(false);

    // Wait until A's world reflects B (so `canPlaceAt`'s overlap check has
    // a current view). When the post-reload A spawns at origin a fresh push
    // pass nudges the two apart along x. B was left at (-r, 0) by the
    // earlier push (B has the lower id and goes -x; r = PLAYER_RADIUS =
    // 0.35); A spawns at (0, 0). Centers 0.35 apart, circle penetration
    // 2r - 0.35 = 0.35; with both stationary the share is 50/50, so each
    // is shoved r/2 = 0.175 — A ends at (0.175, 0), B at (-0.525, 0).
    // Both clear of the target cell (1, 1) (nearest distance ≥ 1).
    await a.waitForFunction(
      (peerId) => {
        return window.__anarchy?.world.getPlayer(peerId) !== undefined;
      },
      (await b.evaluate(() => window.__anarchy!.getLocalPlayerId()))!,
    );

    // Toggle builder + place at chunk (0, 0) local (1, 1) — center
    // (1.5, 1.5). From A at ~(0.175, 0): distance ≈ √(1.756 + 2.25) ≈ 2.00
    // — in reach. No player circle overlaps cell (1, 1): B at (-0.525, 0)
    // is √((1+0.525)² + 1²) ≈ 1.83 from the nearest cell point, A at
    // (0.175, 0) is √(0.825² + 1²) ≈ 1.30 — both well past PLAYER_RADIUS.
    await a.evaluate(() => window.__anarchy!.setBuilderMode(true));
    await a.waitForFunction(() => window.__anarchy!.canPlaceAt(0, 0, 1, 1));
    await a.evaluate(() => window.__anarchy!.sendPlaceBlock(0, 0, 1, 1, 4));

    // Both A and B observe the gold block. B is the surviving party from
    // before A reconnected — it must have seen A's despawn (old id) and
    // respawn (new id) without losing its own connection or its world.
    await waitForTopBlockKind(a, cx, cy, lx, ly, "Gold");
    await waitForTopBlockKind(b, cx, cy, lx, ly, "Gold");
    expect(b.isClosed()).toBe(false);
  } finally {
    await ctxA.close();
    await ctxB.close();
    await clearTopBlock(cx, cy, lx, ly);
  }
});
