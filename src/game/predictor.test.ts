import { describe, expect, it } from "vitest";

import {
  LocalPredictor,
  RECONCILE_SNAP_DISTANCE,
  SPEED,
} from "./predictor.js";

describe("LocalPredictor", () => {
  it("starts at origin with zero intent", () => {
    const p = new LocalPredictor();
    expect(p.position(0)).toEqual({ x: 0, y: 0 });
    expect(p.intentForTest()).toEqual({ dx: 0, dy: 0 });
    expect(p.latestSentSeqForTest()).toBe(0);
  });

  it("doesn't move on the first position() call (initializes the timer)", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 1);
    // Even though intent is non-zero, the first call only seeds lastAdvancedAt.
    expect(p.position(1_000)).toEqual({ x: 0, y: 0 });
  });

  it("advances by intent * SPEED * dt between successive position() calls", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 1);
    p.position(1_000);
    // 200 ms east at SPEED=5 → x = 1.
    const pos = p.position(1_200);
    expect(pos.x).toBeCloseTo(1);
    expect(pos.y).toBe(0);
  });

  it("integrates intent changes between samples (state-replacing)", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 1);
    p.position(1_000);
    p.position(1_200); // east 1.0
    p.setIntent(0, 1, 2); // switch to north
    const pos = p.position(1_400); // north 1.0 over the next 200 ms
    expect(pos.x).toBeCloseTo(1);
    expect(pos.y).toBeCloseTo(1);
  });

  it("uses the configured speed for projection", () => {
    const p = new LocalPredictor(10); // 2x SPEED
    p.setIntent(1, 0, 1);
    p.position(0);
    expect(p.position(1_000).x).toBeCloseTo(10);
  });

  it("setIntent advances the latest seq monotonically", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 5);
    p.setIntent(0, 1, 3); // out-of-order: must not roll back
    expect(p.latestSentSeqForTest()).toBe(5);
    // ...but the intent did update (callers know what they're sending).
    expect(p.intentForTest()).toEqual({ dx: 0, dy: 1 });
  });

  it("reset re-anchors position and clears intent + seq", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 9);
    p.position(0);
    p.position(1_000);

    p.reset(7, -3);
    expect(p.position(2_000)).toEqual({ x: 7, y: -3 });
    expect(p.intentForTest()).toEqual({ dx: 0, dy: 0 });
    expect(p.latestSentSeqForTest()).toBe(0);
  });

  it("reconcile snaps to server position when ackedSeq has caught up and divergence is large", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 1);
    p.position(0);
    p.position(1_000); // predicted x=5

    // Server says we're at x=0 (e.g., bumped a wall), seq=1 acked.
    p.reconcile(0, 0, 1);
    expect(p.position(1_000)).toEqual({ x: 0, y: 0 });
  });

  it("reconcile leaves predicted alone when divergence is within the lag tolerance", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 1);
    p.position(0);
    p.position(1_000); // predicted x=5

    // Server sees x=4.5 — half a unit behind (typical 100 ms lag at SPEED=5).
    // Snap distance is 1.5, so this should NOT snap.
    p.reconcile(4.5, 0, 1);
    expect(p.position(1_000)).toEqual({ x: 5, y: 0 });
  });

  it("reconcile is a no-op while the server hasn't acked the latest sent seq", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 5); // sent seq=5
    p.position(0);
    p.position(1_000); // predicted x=5

    // Server only acked seq=2 — predicted is correctly running ahead. Even
    // though server pos differs by a lot, we don't snap (the server hasn't
    // seen our latest input yet).
    p.reconcile(0, 0, 2);
    expect(p.position(1_000)).toEqual({ x: 5, y: 0 });
  });

  it("reconcile honors the configured snap distance", () => {
    const p = new LocalPredictor(SPEED, /*snapDistance=*/ 0.1);
    p.setIntent(1, 0, 1);
    p.position(0);
    p.position(1_000); // x=5

    // Tiny snap threshold — 0.5 units of normal lag is now over the limit.
    p.reconcile(4.5, 0, 1);
    expect(p.position(1_000).x).toBeCloseTo(4.5);
  });

  it("exposes a finite, tuned snap distance", () => {
    expect(RECONCILE_SNAP_DISTANCE).toBeGreaterThan(0);
    expect(Number.isFinite(RECONCILE_SNAP_DISTANCE)).toBe(true);
  });

  it("asPlayer wraps position() into a Player record", () => {
    const p = new LocalPredictor();
    p.setIntent(1, 0, 1);
    p.position(0);
    const me = p.asPlayer(42, 1_000);
    expect(me.id).toBe(42);
    expect(me.x).toBeCloseTo(5);
    expect(me.y).toBe(0);
  });
});
