import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  MAX_TORCH_LIGHTS,
  TorchLights,
  createTorchLight,
} from "./torch_lights.js";

describe("createTorchLight", () => {
  it("returns a warm-tinted PointLight with finite distance + decay", () => {
    const light = createTorchLight();
    expect(light).toBeInstanceOf(THREE.PointLight);
    // Warm flame tint shared with the lantern: red dominates blue.
    expect(light.color.r).toBeGreaterThan(light.color.b);
    expect(light.distance).toBeGreaterThan(0);
    expect(light.decay).toBeGreaterThan(0);
  });
});

describe("TorchLights pool", () => {
  it("tracks per-chunk torches and refreshes wholesale on set/remove", () => {
    const lights = new TorchLights();
    expect(lights.trackedTorchCount()).toBe(0);
    lights.setChunkTorches(0, 0, [
      { x: 1, z: 2 },
      { x: 3, z: 4 },
    ]);
    lights.setChunkTorches(1, 0, [{ x: 20, z: 0 }]);
    expect(lights.trackedTorchCount()).toBe(3);
    // Empty positions array is the same as removeChunk.
    lights.setChunkTorches(0, 0, []);
    expect(lights.trackedTorchCount()).toBe(1);
    lights.removeChunk(1, 0);
    expect(lights.trackedTorchCount()).toBe(0);
  });

  it("hides every pool light at noon (nightFactor == 0)", () => {
    const lights = new TorchLights();
    lights.setChunkTorches(0, 0, [{ x: 0, z: 0 }]);
    lights.update({ x: 0, z: 0 }, 0);
    const group = lights.scene();
    for (const child of group.children) {
      expect(child).toBeInstanceOf(THREE.PointLight);
      expect(child.visible).toBe(false);
    }
  });

  it("scales intensity linearly with the night factor", () => {
    const peak = TorchLights.intensityAt(1);
    expect(TorchLights.intensityAt(0)).toBe(0);
    expect(TorchLights.intensityAt(0.5)).toBeCloseTo(peak * 0.5);
    expect(TorchLights.intensityAt(1)).toBe(peak);
    // Out-of-range inputs clamp into [0, 1].
    expect(TorchLights.intensityAt(-1)).toBe(0);
    expect(TorchLights.intensityAt(1.5)).toBe(peak);
  });

  it("at midnight, the lit pool slots match the tracked torches", () => {
    const lights = new TorchLights();
    lights.setChunkTorches(0, 0, [
      { x: 1, z: 1 },
      { x: 3, z: 0 },
      { x: 0, z: 5 },
    ]);
    lights.update({ x: 0, z: 0 }, 1);
    const visible = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    expect(visible).toHaveLength(3);
    const peak = TorchLights.intensityAt(1);
    for (const v of visible) expect(v.intensity).toBeCloseTo(peak);
  });

  it("caps the lit pool at MAX_TORCH_LIGHTS, picking nearest first", () => {
    const lights = new TorchLights();
    // Place MAX + 5 torches stretching out along +x — distance == x.
    const positions: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < MAX_TORCH_LIGHTS + 5; i++) {
      positions.push({ x: i + 1, z: 0 });
    }
    lights.setChunkTorches(0, 0, positions);
    lights.update({ x: 0, z: 0 }, 1);
    const visibleLights = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    expect(visibleLights).toHaveLength(MAX_TORCH_LIGHTS);
    // The visible lights should be at the smallest x values (nearest to
    // origin); the largest visible x must be `MAX_TORCH_LIGHTS` (the 32nd
    // closest), not `MAX_TORCH_LIGHTS + 5`.
    const maxVisibleX = Math.max(...visibleLights.map((l) => l.position.x));
    expect(maxVisibleX).toBe(MAX_TORCH_LIGHTS);
  });

  it("refocusing the player picks a different 32 nearest", () => {
    const lights = new TorchLights(2); // small pool to keep the test legible
    lights.setChunkTorches(0, 0, [
      { x: -10, z: 0 },
      { x: -5, z: 0 },
      { x: 5, z: 0 },
      { x: 10, z: 0 },
    ]);
    lights.update({ x: 0, z: 0 }, 1);
    let visible = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    // Two nearest to origin are at +/- 5.
    expect(visible.map((v) => Math.abs(v.position.x)).sort()).toEqual([5, 5]);
    // Move focus to x=10; nearest are 5 (+5 away) and 10 (0 away).
    lights.update({ x: 10, z: 0 }, 1);
    visible = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    const xs = visible.map((v) => v.position.x).sort((a, b) => a - b);
    expect(xs).toEqual([5, 10]);
  });
});
