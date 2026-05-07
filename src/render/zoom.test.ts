import { describe, expect, it } from "vitest";

import { ZOOM_HEIGHT_MAX, ZOOM_HEIGHT_MIN } from "../config.js";
import { ZoomController, clampZoomHeight, easeInOutCubic } from "./zoom.js";

describe("easeInOutCubic", () => {
  it("anchors the curve at (0, 0) and (1, 1)", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it("crosses 0.5 at t=0.5 (curve symmetry)", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });

  it("is monotonic across the unit interval", () => {
    let prev = easeInOutCubic(0);
    for (let i = 1; i <= 20; i++) {
      const cur = easeInOutCubic(i / 20);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("clamps t outside [0, 1]", () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe("ZoomController.sample", () => {
  it("returns the initial value before any retarget", () => {
    const c = new ZoomController(14, 200, 0);
    expect(c.sample(0)).toBe(14);
    expect(c.sample(500)).toBe(14);
  });

  it("eases from start to target across the duration", () => {
    const c = new ZoomController(10, 200, 0);
    c.setTarget(20, 0);
    expect(c.sample(0)).toBe(10);
    // Mid-tween sits halfway — ease-in-out cubic crosses 0.5 at t=0.5.
    expect(c.sample(100)).toBeCloseTo(15, 10);
    expect(c.sample(200)).toBe(20);
  });

  it("parks at target once the tween elapses", () => {
    const c = new ZoomController(10, 200, 0);
    c.setTarget(20, 0);
    expect(c.sample(500)).toBe(20);
    // Subsequent samples remain at target without re-easing.
    expect(c.sample(10_000)).toBe(20);
  });

  it("setTarget with the current target is a no-op (preserves in-flight tween)", () => {
    const c = new ZoomController(10, 200, 0);
    c.setTarget(20, 0);
    const mid = c.sample(80);
    c.setTarget(20, 80); // same target — must not restart the tween
    expect(c.sample(80)).toBe(mid);
    // Tween still completes by the original deadline.
    expect(c.sample(200)).toBe(20);
  });
});

describe("ZoomController retarget mid-tween", () => {
  it("starts the new tween from the currently-sampled value (no jump)", () => {
    const c = new ZoomController(10, 200, 0);
    c.setTarget(20, 0);
    const mid = c.sample(100); // halfway, ≈15
    c.setTarget(5, 100);
    // Sampling immediately after the retarget must equal `mid` — any
    // discontinuity here is the bug we're guarding against.
    expect(c.sample(100)).toBeCloseTo(mid, 10);
    // And the new tween eventually reaches its target.
    expect(c.sample(300)).toBe(5);
  });

  it("a chain of mid-tween retargets stays continuous at every hand-off", () => {
    const c = new ZoomController(10, 200, 0);
    c.setTarget(40, 0);
    const a = c.sample(50);
    c.setTarget(20, 50);
    expect(c.sample(50)).toBeCloseTo(a, 10);
    const b = c.sample(120);
    c.setTarget(80, 120);
    expect(c.sample(120)).toBeCloseTo(b, 10);
    expect(c.sample(400)).toBe(80);
  });

  it("isTweening flips false once parked", () => {
    const c = new ZoomController(10, 200, 0);
    expect(c.isTweening(0)).toBe(false);
    c.setTarget(20, 0);
    expect(c.isTweening(0)).toBe(true);
    expect(c.isTweening(199)).toBe(true);
    expect(c.isTweening(200)).toBe(false);
  });
});

describe("clampZoomHeight", () => {
  it("clamps below min and above max", () => {
    expect(clampZoomHeight(ZOOM_HEIGHT_MIN - 5)).toBe(ZOOM_HEIGHT_MIN);
    expect(clampZoomHeight(ZOOM_HEIGHT_MAX + 5)).toBe(ZOOM_HEIGHT_MAX);
  });

  it("passes through values inside the range", () => {
    const mid = (ZOOM_HEIGHT_MIN + ZOOM_HEIGHT_MAX) / 2;
    expect(clampZoomHeight(mid)).toBe(mid);
  });
});
