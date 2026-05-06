import { describe, expect, it } from "vitest";

import { EffectsLayer } from "./effects.js";

/**
 * Effects layer is renderer-internal but exercises a tiny lifecycle that
 * matches the task spec: events come in, time advances, expired effects
 * dispose themselves. The tests below pin those mechanics without
 * touching a real `Renderer` (a Three.js renderer needs a WebGL context).
 */
function makeLayer() {
  // No real player resolution needed for lifecycle tests — palette[0] is
  // returned via the `null` fallback inside the layer.
  return new EffectsLayer(() => null);
}

function countChildren(layer: EffectsLayer): number {
  return layer.scene().children.length;
}

describe("EffectsLayer", () => {
  it("spawns a place pulse on a placed block edit", () => {
    const layer = makeLayer();
    expect(countChildren(layer)).toBe(0);
    layer.onBlockEdit(
      { playerId: 1, kind: "placed", cx: 0, cy: 0, lx: 0, ly: 0 },
      0,
    );
    expect(countChildren(layer)).toBe(1);
  });

  it("spawns a break shatter on a broken block edit", () => {
    const layer = makeLayer();
    layer.onBlockEdit(
      { playerId: 1, kind: "broken", cx: 1, cy: 2, lx: 3, ly: 4 },
      0,
    );
    expect(countChildren(layer)).toBe(1);
  });

  it("expires a place pulse once its duration elapses", () => {
    const layer = makeLayer();
    layer.onBlockEdit(
      { playerId: 1, kind: "placed", cx: 0, cy: 0, lx: 0, ly: 0 },
      1_000,
    );
    expect(countChildren(layer)).toBe(1);
    layer.update(1_124);
    expect(countChildren(layer)).toBe(1);
    // Duration is 250ms — past the end the pulse is disposed.
    layer.update(1_500);
    expect(countChildren(layer)).toBe(0);
  });

  it("expires a break shatter once its duration elapses", () => {
    const layer = makeLayer();
    layer.onBlockEdit(
      { playerId: 1, kind: "broken", cx: 0, cy: 0, lx: 0, ly: 0 },
      0,
    );
    expect(countChildren(layer)).toBe(1);
    // Shatter duration is 350ms.
    layer.update(500);
    expect(countChildren(layer)).toBe(0);
  });

  it("creates a targeting overlay when a targeting state appears", () => {
    const layer = makeLayer();
    layer.applyTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 5, ly: 6, durabilityPct: 75 },
    ]);
    expect(countChildren(layer)).toBe(1);
  });

  it("removes a targeting overlay when the player disappears from the set", () => {
    const layer = makeLayer();
    layer.applyTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0, durabilityPct: 100 },
    ]);
    expect(countChildren(layer)).toBe(1);
    layer.applyTargets([]);
    expect(countChildren(layer)).toBe(0);
  });

  it("re-uses the targeting overlay when the same player re-targets", () => {
    const layer = makeLayer();
    layer.applyTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0, durabilityPct: 100 },
    ]);
    expect(countChildren(layer)).toBe(1);
    layer.applyTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 1, ly: 1, durabilityPct: 50 },
    ]);
    // Still one overlay — no churn on re-target.
    expect(countChildren(layer)).toBe(1);
  });

  it("supports multiple players targeting different cells simultaneously", () => {
    const layer = makeLayer();
    layer.applyTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0, durabilityPct: 100 },
      { playerId: 2, cx: 0, cy: 0, lx: 5, ly: 5, durabilityPct: 50 },
    ]);
    expect(countChildren(layer)).toBe(2);
    // Drop player 2 only.
    layer.applyTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0, durabilityPct: 80 },
    ]);
    expect(countChildren(layer)).toBe(1);
  });

  it("clears all owned scene state on dispose", () => {
    const layer = makeLayer();
    layer.onBlockEdit(
      { playerId: 1, kind: "placed", cx: 0, cy: 0, lx: 0, ly: 0 },
      0,
    );
    layer.applyTargets([
      { playerId: 2, cx: 0, cy: 0, lx: 1, ly: 1, durabilityPct: 50 },
    ]);
    expect(countChildren(layer)).toBe(2);
    layer.dispose();
    expect(countChildren(layer)).toBe(0);
  });
});
