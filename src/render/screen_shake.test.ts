import { describe, expect, it } from "vitest";

import {
  durationForDamage,
  magnitudeForDamage,
  SCREEN_SHAKE_TUNING,
  ScreenShake,
} from "./screen_shake.js";

const {
  MIN_SHAKE_TILES,
  MAX_SHAKE_TILES,
  MIN_SHAKE_DURATION_MS,
  MAX_SHAKE_DURATION_MS,
} = SCREEN_SHAKE_TUNING;

describe("ScreenShake.offsetAt", () => {
  it("returns (0, 0) when no shake has been triggered", () => {
    const shake = new ScreenShake();
    expect(shake.offsetAt(0)).toEqual({ dx: 0, dy: 0 });
    expect(shake.offsetAt(1_000_000)).toEqual({ dx: 0, dy: 0 });
  });

  it("returns a non-zero offset within the active window and zero after", () => {
    const shake = new ScreenShake();
    shake.trigger(0.3, 300, 0);
    const mid = shake.offsetAt(100);
    expect(Math.abs(mid.dx) + Math.abs(mid.dy)).toBeGreaterThan(0);

    const after = shake.offsetAt(300);
    expect(after).toEqual({ dx: 0, dy: 0 });
    const wellAfter = shake.offsetAt(10_000);
    expect(wellAfter).toEqual({ dx: 0, dy: 0 });
  });

  it("decays amplitude linearly to zero at startMs + durationMs", () => {
    const shake = new ScreenShake();
    shake.trigger(0.3, 300, 0);
    // Each axis is scaled independently by `amplitude * (sin|cos)(...)`,
    // so the per-axis envelope is `amplitude` (the per-axis magnitude
    // can't exceed it, even though both axes combined could in theory
    // reach `amplitude * sqrt(2)`).
    const at0 = shake.offsetAt(0);
    const at150 = shake.offsetAt(150);
    const at300 = shake.offsetAt(300);

    expect(Math.abs(at0.dx)).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(Math.abs(at0.dy)).toBeLessThanOrEqual(0.3 + 1e-9);
    // At t = duration/2 the per-axis envelope is exactly amplitude/2.
    expect(Math.abs(at150.dx)).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(Math.abs(at150.dy)).toBeLessThanOrEqual(0.15 + 1e-9);
    // Amplitude envelope must be exactly 0 at the endpoint.
    expect(at300.dx).toBe(0);
    expect(at300.dy).toBe(0);
  });
});

describe("ScreenShake.trigger overlap", () => {
  it("takes the max magnitude rather than summing", () => {
    const a = new ScreenShake();
    a.trigger(0.3, 200, 0);
    a.trigger(0.1, 200, 50);
    // Equivalent reference: one shake at 0.3 starting at t=50, duration 200.
    const ref = new ScreenShake();
    ref.trigger(0.3, 200, 50);

    // Same envelope amplitude at the same sample point — direction is
    // deterministic in `nowMs`, so the offsets match exactly.
    expect(a.offsetAt(100)).toEqual(ref.offsetAt(100));
  });

  it("keeps the longer remaining duration on overlap", () => {
    const shake = new ScreenShake();
    shake.trigger(0.2, 100, 0);
    // At t=10 the original has 90 ms remaining; a new 200 ms trigger
    // should win — the merged shake should still be alive at t=180.
    shake.trigger(0.2, 200, 10);
    const late = shake.offsetAt(180);
    expect(Math.abs(late.dx) + Math.abs(late.dy)).toBeGreaterThan(0);
  });

  it("replaces the active shake when the previous one has fully decayed", () => {
    const shake = new ScreenShake();
    shake.trigger(0.3, 100, 0);
    // Original has expired by t=200; a fresh trigger at t=200 anchors
    // afresh without inheriting the previous magnitude — per-axis
    // amplitude can't exceed the fresh 0.05 ceiling.
    shake.trigger(0.05, 100, 200);
    const at210 = shake.offsetAt(210);
    expect(Math.abs(at210.dx)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(Math.abs(at210.dy)).toBeLessThanOrEqual(0.05 + 1e-9);
  });
});

describe("ScreenShake.trigger clamps to MAX_SHAKE_TILES", () => {
  it("an absurd magnitude collapses to the failsafe ceiling", () => {
    const shake = new ScreenShake();
    shake.trigger(999, 300, 0);
    // Per-axis envelope is bounded by the clamped magnitude.
    const off = shake.offsetAt(0);
    expect(Math.abs(off.dx)).toBeLessThanOrEqual(MAX_SHAKE_TILES + 1e-9);
    expect(Math.abs(off.dy)).toBeLessThanOrEqual(MAX_SHAKE_TILES + 1e-9);
  });
});

describe("ScreenShake.reset", () => {
  it("drops an in-flight shake", () => {
    const shake = new ScreenShake();
    shake.trigger(0.3, 300, 0);
    shake.reset();
    expect(shake.offsetAt(100)).toEqual({ dx: 0, dy: 0 });
  });
});

describe("magnitudeForDamage", () => {
  it("returns the floor for small damage", () => {
    expect(magnitudeForDamage(1)).toBe(MIN_SHAKE_TILES);
    expect(magnitudeForDamage(5)).toBe(MIN_SHAKE_TILES);
  });

  it("returns the ceiling for full / oversaturated damage", () => {
    expect(magnitudeForDamage(100)).toBe(MAX_SHAKE_TILES);
    expect(magnitudeForDamage(9999)).toBe(MAX_SHAKE_TILES);
  });

  it("interpolates strictly between floor and ceiling for mid-range damage", () => {
    const mid = magnitudeForDamage(50);
    expect(mid).toBeGreaterThan(MIN_SHAKE_TILES);
    expect(mid).toBeLessThan(MAX_SHAKE_TILES);
  });

  it("returns 0 for non-positive damage", () => {
    expect(magnitudeForDamage(0)).toBe(0);
    expect(magnitudeForDamage(-5)).toBe(0);
  });
});

describe("durationForDamage", () => {
  it("returns the floor for small damage", () => {
    expect(durationForDamage(1)).toBeGreaterThanOrEqual(MIN_SHAKE_DURATION_MS);
    expect(durationForDamage(1)).toBeLessThan(MIN_SHAKE_DURATION_MS + 10);
  });

  it("returns the ceiling for full / oversaturated damage", () => {
    expect(durationForDamage(100)).toBe(MAX_SHAKE_DURATION_MS);
    expect(durationForDamage(9999)).toBe(MAX_SHAKE_DURATION_MS);
  });

  it("returns 0 for non-positive damage", () => {
    expect(durationForDamage(0)).toBe(0);
    expect(durationForDamage(-5)).toBe(0);
  });
});
