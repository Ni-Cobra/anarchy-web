import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  MAX_MUSHROOM_LIGHTS,
  MushroomLights,
  createMushroomLight,
} from "./mushroom_lights.js";

describe("createMushroomLight", () => {
  it("returns a cool-tinted PointLight with finite distance + decay", () => {
    const light = createMushroomLight();
    expect(light).toBeInstanceOf(THREE.PointLight);
    // Cool tint — blue/cyan dominates red so a torch + a mushroom in the
    // same frame read as distinctly different light sources.
    expect(light.color.b).toBeGreaterThan(light.color.r);
    expect(light.distance).toBeGreaterThan(0);
    expect(light.decay).toBeGreaterThan(0);
  });
});

describe("MushroomLights pool", () => {
  it("tracks per-chunk mushrooms and refreshes wholesale on set/remove", () => {
    const lights = new MushroomLights();
    expect(lights.trackedMushroomCount()).toBe(0);
    lights.setChunkMushrooms(0, 0, [
      { x: 1, z: 2 },
      { x: 3, z: 4 },
    ]);
    lights.setChunkMushrooms(1, 0, [{ x: 20, z: 0 }]);
    expect(lights.trackedMushroomCount()).toBe(3);
    lights.setChunkMushrooms(0, 0, []);
    expect(lights.trackedMushroomCount()).toBe(1);
    lights.removeChunk(1, 0);
    expect(lights.trackedMushroomCount()).toBe(0);
  });

  it("hides every pool light at noon (nightFactor == 0)", () => {
    const lights = new MushroomLights();
    lights.setChunkMushrooms(0, 0, [{ x: 0, z: 0 }]);
    lights.update({ x: 0, z: 0 }, 0);
    const group = lights.scene();
    for (const child of group.children) {
      expect(child).toBeInstanceOf(THREE.PointLight);
      expect(child.visible).toBe(false);
    }
  });

  it("scales intensity linearly with the night factor", () => {
    const peak = MushroomLights.intensityAt(1);
    expect(MushroomLights.intensityAt(0)).toBe(0);
    expect(MushroomLights.intensityAt(0.5)).toBeCloseTo(peak * 0.5);
    expect(MushroomLights.intensityAt(1)).toBe(peak);
    expect(MushroomLights.intensityAt(-1)).toBe(0);
    expect(MushroomLights.intensityAt(1.5)).toBe(peak);
  });

  it("mushroom peak intensity is weaker than a torch", async () => {
    const { TorchLights } = await import("./torch_lights.js");
    expect(MushroomLights.intensityAt(1)).toBeLessThan(
      TorchLights.intensityAt(1),
    );
  });

  it("at midnight, the lit pool slots match the tracked mushrooms", () => {
    const lights = new MushroomLights();
    lights.setChunkMushrooms(0, 0, [
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
    const peak = MushroomLights.intensityAt(1);
    for (const v of visible) expect(v.intensity).toBeCloseTo(peak);
  });

  it("caps the lit pool at MAX_MUSHROOM_LIGHTS, picking nearest first", () => {
    const lights = new MushroomLights();
    const positions: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < MAX_MUSHROOM_LIGHTS + 5; i++) {
      positions.push({ x: i + 1, z: 0 });
    }
    lights.setChunkMushrooms(0, 0, positions);
    lights.update({ x: 0, z: 0 }, 1);
    const visibleLights = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    expect(visibleLights).toHaveLength(MAX_MUSHROOM_LIGHTS);
    const maxVisibleX = Math.max(...visibleLights.map((l) => l.position.x));
    expect(maxVisibleX).toBe(MAX_MUSHROOM_LIGHTS);
  });

  it("releases lights when a chunk unloads", () => {
    const lights = new MushroomLights(4);
    lights.setChunkMushrooms(0, 0, [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ]);
    lights.update({ x: 0, z: 0 }, 1);
    let visible = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    expect(visible).toHaveLength(2);
    lights.removeChunk(0, 0);
    lights.update({ x: 0, z: 0 }, 1);
    visible = lights
      .scene()
      .children.filter(
        (c): c is THREE.PointLight =>
          c instanceof THREE.PointLight && c.visible,
      );
    expect(visible).toHaveLength(0);
  });
});
