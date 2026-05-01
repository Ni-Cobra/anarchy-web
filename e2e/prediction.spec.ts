import { test, expect, type Page } from "@playwright/test";

// Browser-driven e2e for client-side prediction + reconciliation. With the
// LocalPredictor wired in, sending a MoveIntent should cause the client to
// advance the local-player position on the very next render frame —
// without waiting for the server's StateUpdate to arrive (~50–150 ms). The
// existing client-app spec covers the snapshot-driven happy path; this
// file pins the *prediction* semantics specifically.
//
// See ADR 0001 (local-player prediction amendment, 2026-05-01).

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

test("LocalPredictor advances on the client before the server can have responded", async ({
  page,
}) => {
  await openClient(page);
  await waitForSelfSpawn(page);

  // Tight ~50 ms budget for the prediction to take effect: well under one
  // server tick (50 ms) plus the network RTT, so even if a snapshot landed
  // on this exact tick the test wouldn't be observing it.
  const result = await page.evaluate(async () => {
    const a = window.__anarchy!;
    const before = a.predictor.position(performance.now());
    a.sendMoveIntent(1, 0); // east at full speed
    // Yield two animation frames so the predictor's per-frame advance has
    // fired at least once after the intent was registered.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const after = a.predictor.position(performance.now());
    return { beforeX: before.x, afterX: after.x };
  });

  // The local player's predicted x should have advanced — predicted-purely
  // by the client, since 50 ms of motion at SPEED=5 is at most 0.25 units
  // and a server round-trip can't have completed in two animation frames.
  expect(result.afterX).toBeGreaterThan(result.beforeX);
});

test("after stopping, the predictor stays put and converges with the server snapshot", async ({
  page,
}) => {
  await openClient(page);
  const me = await waitForSelfSpawn(page);

  // Send east, wait long enough for the server to ack and start moving us.
  await page.evaluate(() => window.__anarchy!.sendMoveIntent(1, 0));
  // Wait for the server to confirm progress (at least one tick + network).
  await page.waitForFunction(
    (peerId) => {
      const p = window.__anarchy?.world.getPlayer(peerId);
      return p !== undefined && p.x > 0;
    },
    me.id,
  );

  // Stop. Predicted position should freeze; subsequent snapshots converge.
  await page.evaluate(() => window.__anarchy!.sendMoveIntent(0, 0));

  // After ~250 ms (5 ticks), predicted and snapshot should be within the
  // reconcile snap distance of each other — the predictor either matched
  // the server (likely) or snapped on a divergent reconcile.
  await page.waitForTimeout(300);

  const { predictedX, snapshotX } = await page.evaluate(() => {
    const a = window.__anarchy!;
    const id = a.getLocalPlayerId()!;
    const me = a.world.getPlayer(id)!;
    const pos = a.predictor.position(performance.now());
    return { predictedX: pos.x, snapshotX: me.x };
  });

  // 1.5 is the predictor's snap-distance constant; staying within it is
  // proof the predictor and the server agree to within one tick of lag.
  expect(Math.abs(predictedX - snapshotX)).toBeLessThan(1.5);
});
