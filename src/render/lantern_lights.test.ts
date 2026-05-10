import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { ItemId } from "../game/index.js";
import { LanternLights, type LanternEntity } from "./lantern_lights.js";

const wearer = (id: number, x = 0, y = 0): LanternEntity => ({
  id,
  x,
  y,
  equippedUtility: ItemId.Lantern,
});

const bareHanded = (id: number, x = 0, y = 0): LanternEntity => ({
  id,
  x,
  y,
  equippedUtility: null,
});

describe("LanternLights", () => {
  it("attaches a point light per lantern-wearer at midnight", () => {
    const layer = new LanternLights();
    layer.update([wearer(1, 4, 0), wearer(2, -3, 5), bareHanded(3, 0, 0)], 1);
    const lights = layer.scene().children.filter(
      (c): c is THREE.PointLight => c instanceof THREE.PointLight,
    );
    expect(lights).toHaveLength(2);
    expect(lights.every((l) => l.visible)).toBe(true);
    expect(layer.visibleCount()).toBe(2);
  });

  it("hides every light at noon without tearing them down", () => {
    const layer = new LanternLights();
    layer.update([wearer(1)], 1);
    expect(layer.visibleCount()).toBe(1);
    layer.update([wearer(1)], 0);
    expect(layer.visibleCount()).toBe(0);
    // Light is still in the pool — a transient day cycle shouldn't churn
    // the scene graph.
    const lights = layer.scene().children.filter(
      (c): c is THREE.PointLight => c instanceof THREE.PointLight,
    );
    expect(lights).toHaveLength(1);
  });

  it("retires the light when a player stops wearing the lantern", () => {
    const layer = new LanternLights();
    layer.update([wearer(1)], 1);
    expect(layer.scene().children).toHaveLength(1);
    layer.update([bareHanded(1)], 1);
    expect(layer.scene().children).toHaveLength(0);
  });

  it("retires the light when a player drops out of the entity list (e.g. left view)", () => {
    const layer = new LanternLights();
    layer.update([wearer(1), wearer(2)], 1);
    expect(layer.scene().children).toHaveLength(2);
    layer.update([wearer(2)], 1);
    expect(layer.scene().children).toHaveLength(1);
  });

  it("scales intensity linearly with the night factor", () => {
    const peak = LanternLights.intensityAt(1);
    expect(LanternLights.intensityAt(0)).toBe(0);
    expect(LanternLights.intensityAt(0.5)).toBeCloseTo(peak * 0.5);
    expect(LanternLights.intensityAt(1)).toBe(peak);
    // Out-of-range inputs clamp into [0, 1].
    expect(LanternLights.intensityAt(-1)).toBe(0);
    expect(LanternLights.intensityAt(1.5)).toBe(peak);
  });

  it("repositions the light when the player moves", () => {
    const layer = new LanternLights();
    layer.update([wearer(1, 0, 0)], 1);
    const light = layer.scene().children[0] as THREE.PointLight;
    const x0 = light.position.x;
    layer.update([wearer(1, 10, 0)], 1);
    expect(light.position.x).not.toBe(x0);
  });
});
