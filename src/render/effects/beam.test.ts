import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { BeamLayer } from "./beam.js";

function makeLayer() {
  return new BeamLayer();
}

function lineCount(layer: BeamLayer): number {
  return layer.scene().children.length;
}

function getLine(layer: BeamLayer, idx: number): THREE.Line {
  return layer.scene().children[idx] as THREE.Line;
}

describe("BeamLayer", () => {
  it("creates a break beam when a player begins targeting", () => {
    const layer = makeLayer();
    expect(lineCount(layer)).toBe(0);
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    expect(lineCount(layer)).toBe(1);
  });

  it("clears a break beam when a player drops out of the targeting set", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    layer.applyBreakTargets([]);
    expect(lineCount(layer)).toBe(0);
  });

  it("re-uses the same beam when a player re-targets", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    const before = getLine(layer, 0);
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 1, ly: 1 }]);
    expect(lineCount(layer)).toBe(1);
    expect(getLine(layer, 0)).toBe(before);
  });

  it("supports multiple players targeting different cells simultaneously", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 },
      { playerId: 2, cx: 0, cy: 0, lx: 5, ly: 5 },
    ]);
    expect(lineCount(layer)).toBe(2);
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    expect(lineCount(layer)).toBe(1);
  });

  it("aims the beam from the player position to the block center on update", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    layer.update((id) => (id === 1 ? { x: 4, y: 6 } : null), 0);
    const line = getLine(layer, 0);
    expect(line.visible).toBe(true);
    const positions = line.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    // Player end: tileToScene(4, 6) = (4, 0.5, -6).
    expect(positions.getX(0)).toBeCloseTo(4);
    expect(positions.getY(0)).toBeCloseTo(0.5);
    expect(positions.getZ(0)).toBeCloseTo(-6);
    // Block end: tileCenterToScene(0,0,0,0) = (0.5, _, -0.5), y at cube center.
    expect(positions.getX(1)).toBeCloseTo(0.5);
    expect(positions.getY(1)).toBeCloseTo(0.55);
    expect(positions.getZ(1)).toBeCloseTo(-0.5);
  });

  it("re-aims a beam to the new target when the player re-targets", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    layer.update(() => ({ x: 0, y: 0 }), 0);
    layer.applyBreakTargets([{ playerId: 1, cx: 1, cy: 0, lx: 2, ly: 3 }]);
    layer.update(() => ({ x: 0, y: 0 }), 0);
    const positions = (
      getLine(layer, 0).geometry.getAttribute("position") as THREE.BufferAttribute
    );
    // tileCenterToScene(1, 0, 2, 3): wx = 16 + 2 + 0.5 = 18.5, wy = 0 + 3 + 0.5 = 3.5.
    expect(positions.getX(1)).toBeCloseTo(18.5);
    expect(positions.getZ(1)).toBeCloseTo(-3.5);
  });

  it("hides a beam whose actor is unknown to the position lookup", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    layer.update(() => null, 0);
    expect(getLine(layer, 0).visible).toBe(false);
  });

  it("starts a freshly-spawned beam hidden until the first update", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    expect(getLine(layer, 0).visible).toBe(false);
  });

  it("spawns a place-flash beam and expires it once its duration elapses", () => {
    const layer = makeLayer();
    layer.onPlace({ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }, 1_000);
    expect(lineCount(layer)).toBe(1);
    layer.update(() => ({ x: 0, y: 0 }), 1_050);
    expect(lineCount(layer)).toBe(1);
    layer.update(() => ({ x: 0, y: 0 }), 1_200);
    expect(lineCount(layer)).toBe(0);
  });

  it("aims the place-flash beam at the placed cell with the actor's position", () => {
    const layer = makeLayer();
    layer.onPlace({ playerId: 7, cx: 0, cy: 0, lx: 1, ly: 1 }, 0);
    layer.update((id) => (id === 7 ? { x: 2.5, y: 2.5 } : null), 50);
    const line = getLine(layer, 0);
    expect(line.visible).toBe(true);
    const positions = line.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    expect(positions.getX(0)).toBeCloseTo(2.5);
    expect(positions.getZ(0)).toBeCloseTo(-2.5);
    // tileCenterToScene(0, 0, 1, 1) = (1.5, _, -1.5).
    expect(positions.getX(1)).toBeCloseTo(1.5);
    expect(positions.getZ(1)).toBeCloseTo(-1.5);
  });

  it("place flashes coexist with break beams on the same player", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    layer.onPlace({ playerId: 1, cx: 0, cy: 0, lx: 5, ly: 5 }, 0);
    expect(lineCount(layer)).toBe(2);
  });

  it("clears all owned scene state on dispose", () => {
    const layer = makeLayer();
    layer.applyBreakTargets([{ playerId: 1, cx: 0, cy: 0, lx: 0, ly: 0 }]);
    layer.onPlace({ playerId: 2, cx: 0, cy: 0, lx: 0, ly: 0 }, 0);
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 3, ly: 3 }]);
    expect(lineCount(layer)).toBe(3);
    layer.dispose();
    expect(lineCount(layer)).toBe(0);
  });

  it("creates a chest beam when a player opens a chest", () => {
    const layer = makeLayer();
    expect(layer.chestBeamCount()).toBe(0);
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 4, ly: 5 }]);
    expect(layer.chestBeamCount()).toBe(1);
  });

  it("clears a chest beam when the chest leaves the open set", () => {
    const layer = makeLayer();
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 4, ly: 5 }]);
    layer.applyChestTargets([]);
    expect(layer.chestBeamCount()).toBe(0);
  });

  it("supports a single player with multiple open chests — one beam per chest", () => {
    const layer = makeLayer();
    layer.applyChestTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 1, ly: 1 },
      { playerId: 1, cx: 0, cy: 0, lx: 2, ly: 2 },
    ]);
    expect(layer.chestBeamCount()).toBe(2);
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 1, ly: 1 }]);
    expect(layer.chestBeamCount()).toBe(1);
  });

  it("re-uses the same chest beam across calls that keep the pair live", () => {
    const layer = makeLayer();
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 2, ly: 3 }]);
    const before = layer.scene().children[0];
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 2, ly: 3 }]);
    expect(layer.chestBeamCount()).toBe(1);
    expect(layer.scene().children[0]).toBe(before);
  });

  it("re-aims the chest beam at the actor's current position on update", () => {
    const layer = makeLayer();
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 4, ly: 5 }]);
    layer.update((id) => (id === 1 ? { x: 7, y: 8 } : null), 0);
    const line = layer.scene().children[0] as THREE.Line;
    const positions = line.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    // Player end: (x=7, _, z=-y=-8).
    expect(positions.getX(0)).toBeCloseTo(7);
    expect(positions.getZ(0)).toBeCloseTo(-8);
    // Chest end: tileCenterToScene(0,0,4,5) = (4.5, _, -5.5).
    expect(positions.getX(1)).toBeCloseTo(4.5);
    expect(positions.getZ(1)).toBeCloseTo(-5.5);
  });

  it("hides a chest beam whose actor is unknown to the position lookup", () => {
    const layer = makeLayer();
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 4, ly: 5 }]);
    layer.update(() => null, 0);
    expect((layer.scene().children[0] as THREE.Line).visible).toBe(false);
  });

  // Task 160 regression pin: the renderer drives `applyChestTargets` +
  // `update` every frame, not only when the player mesh re-syncs. A
  // standing-still driver tick that just observes a new open chest must
  // still spawn the beam in the same frame, and a tick that clears the
  // open set must clear it — no position change required either direction.
  it("opens and clears chest beams from set-diff calls alone, without any player movement", () => {
    const layer = makeLayer();
    const pos = { x: 3, y: 4 };
    const lookup = (id: number) => (id === 1 ? pos : null);

    // Quiescent: no open chests, position lookup steady — nothing to draw.
    layer.update(lookup, 0);
    expect(layer.chestBeamCount()).toBe(0);

    // World reports an open chest this tick. Same position lookup; the
    // beam set diff alone must produce a visible beam.
    layer.applyChestTargets([{ playerId: 1, cx: 0, cy: 0, lx: 4, ly: 5 }]);
    layer.update(lookup, 0);
    expect(layer.chestBeamCount()).toBe(1);
    const line = layer.scene().children[0] as THREE.Line;
    expect(line.visible).toBe(true);

    // Player opens a second chest, still standing still. One beam per
    // (player, chest) must coexist — pins the multi-open invariant.
    layer.applyChestTargets([
      { playerId: 1, cx: 0, cy: 0, lx: 4, ly: 5 },
      { playerId: 1, cx: 0, cy: 0, lx: 6, ly: 7 },
    ]);
    layer.update(lookup, 0);
    expect(layer.chestBeamCount()).toBe(2);

    // Player closes both chests in the same tick. Same position; the
    // wholesale-replace must clear both beams that frame.
    layer.applyChestTargets([]);
    layer.update(lookup, 0);
    expect(layer.chestBeamCount()).toBe(0);
  });
});
