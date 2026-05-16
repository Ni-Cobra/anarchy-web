/**
 * Unit tests for the entity render layer's math: interpolation curve and
 * the on-tile stacking offsets. The class itself (`EntityLayer`) is
 * exercised in the e2e spec — these tests pin the pure-function pieces
 * that have no Three.js dependency.
 */

import { describe, expect, it } from "vitest";

import {
  ENTITY_STACK_OFFSET_RADIUS,
  SPIDER_HEIGHT,
  SPIDER_SIDE,
  SPIDER_Y,
  entityLerpPosition,
  smoothstep,
  stackingOffset,
} from "./entity_layer.js";

describe("smoothstep", () => {
  it("clamps below 0 to 0 and above 1 to 1", () => {
    expect(smoothstep(-0.5)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
  });

  it("returns 0.5 at the midpoint (symmetry)", () => {
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 10);
  });
});

describe("entityLerpPosition", () => {
  it("returns the source at t = 0", () => {
    const p = entityLerpPosition(2, 3, 8, 9, 0);
    expect(p.x).toBe(2);
    expect(p.y).toBe(3);
  });

  it("returns the smoothstep midpoint at t = 0.5", () => {
    const p = entityLerpPosition(0, 0, 10, 20, 0.5);
    // smoothstep(0.5) === 0.5, so the midpoint matches a plain lerp here.
    expect(p.x).toBeCloseTo(5, 10);
    expect(p.y).toBeCloseTo(10, 10);
  });

  it("returns the target at t = 1", () => {
    const p = entityLerpPosition(2, 3, 8, 9, 1);
    expect(p.x).toBe(8);
    expect(p.y).toBe(9);
  });

  it("clamps t below 0 to the source", () => {
    const p = entityLerpPosition(2, 3, 8, 9, -0.5);
    expect(p.x).toBe(2);
    expect(p.y).toBe(3);
  });

  it("clamps t above 1 to the target", () => {
    const p = entityLerpPosition(2, 3, 8, 9, 1.5);
    expect(p.x).toBe(8);
    expect(p.y).toBe(9);
  });

  it("eases slowly off the start (smoothstep, not linear)", () => {
    // At t = 0.25, plain lerp gives 0.25; smoothstep gives 0.15625. The
    // curve must be below the linear midpoint in the first quarter, so
    // the output is strictly below 2.5 across (0, 10).
    const p = entityLerpPosition(0, 0, 10, 0, 0.25);
    expect(p.x).toBeLessThan(2.5);
    expect(p.x).toBeGreaterThan(0);
  });
});

describe("spider mesh dimensions", () => {
  it("is a quarter-tile cube (task 040)", () => {
    // The brief calls for a 0.25 × 0.25 × 0.25 cube — block-shaped, not a
    // flat slab — so the spider reads against walkable top-layer decor.
    expect(SPIDER_SIDE).toBeCloseTo(0.25, 10);
    expect(SPIDER_HEIGHT).toBeCloseTo(0.25, 10);
  });

  it("sits with its bottom face above the tallest walkable top-layer block", () => {
    // Mirrors the renderer constants in `terrain.ts`: the tallest
    // walkable (non-solid) top-layer block is the Torch at
    //   TORCH_BOTTOM (0.025) + TORCH_HEIGHT (0.85) = 0.875.
    // The spider's bottom face must clear that so it draws *above* any
    // walkable top-layer item co-occupying its tile (sticks/flowers/etc.).
    const WALKABLE_TOP_LAYER_MAX_Y = 0.875;
    const spiderBottomY = SPIDER_Y - SPIDER_HEIGHT / 2;
    expect(spiderBottomY).toBeGreaterThanOrEqual(WALKABLE_TOP_LAYER_MAX_Y);
  });
});

describe("stackingOffset", () => {
  it("returns the origin for a lone entity (N = 1)", () => {
    expect(stackingOffset(0, 1)).toEqual({ dx: 0, dy: 0 });
  });

  it("places two entities diametrically opposite on the offset circle (N = 2)", () => {
    const a = stackingOffset(0, 2);
    const b = stackingOffset(1, 2);
    // They sit on a circle of radius `ENTITY_STACK_OFFSET_RADIUS` and
    // are 180° apart, so adding their dx/dy zeroes out.
    expect(a.dx + b.dx).toBeCloseTo(0, 10);
    expect(a.dy + b.dy).toBeCloseTo(0, 10);
    // Each sits on the offset circle.
    expect(Math.hypot(a.dx, a.dy)).toBeCloseTo(ENTITY_STACK_OFFSET_RADIUS, 10);
    expect(Math.hypot(b.dx, b.dy)).toBeCloseTo(ENTITY_STACK_OFFSET_RADIUS, 10);
  });

  it("returns 5 distinct offsets, all on the offset circle (N = 5)", () => {
    const offsets = [0, 1, 2, 3, 4].map((rank) => stackingOffset(rank, 5));
    // Every offset sits on the same circle.
    for (const o of offsets) {
      expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(
        ENTITY_STACK_OFFSET_RADIUS,
        10,
      );
    }
    // Every offset is distinct (no two ranks coincide).
    const keys = new Set(offsets.map((o) => `${o.dx.toFixed(8)},${o.dy.toFixed(8)}`));
    expect(keys.size).toBe(5);
  });

  it("returns stable offsets across calls (deterministic)", () => {
    const first = stackingOffset(2, 5);
    const second = stackingOffset(2, 5);
    expect(first).toEqual(second);
  });
});
