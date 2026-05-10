import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { ItemId, type PlayerId } from "../game/index.js";
import { applyLanternGlow, type LanternGlowEntity } from "./player_mesh.js";

function bodyMesh(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 8, 8),
    new THREE.MeshLambertMaterial({ color: 0x808080 }),
  );
}

const entity = (id: PlayerId, equippedUtility: ItemId | null): LanternGlowEntity => ({
  id,
  equippedUtility,
});

describe("applyLanternGlow", () => {
  it("turns the body emissive white for lantern-wearers and black for others", () => {
    const meshes = new Map<PlayerId, THREE.Mesh>();
    meshes.set(1, bodyMesh());
    meshes.set(2, bodyMesh());

    applyLanternGlow(meshes, [
      entity(1, ItemId.Lantern),
      entity(2, null),
    ]);

    const lit = meshes.get(1)!.material as THREE.MeshLambertMaterial;
    const dark = meshes.get(2)!.material as THREE.MeshLambertMaterial;
    expect(lit.emissive.getHex()).toBe(0xffffff);
    expect(lit.emissiveIntensity).toBeGreaterThan(0);
    expect(dark.emissive.getHex()).toBe(0x000000);
    expect(dark.emissiveIntensity).toBe(0);
  });

  it("re-applies each call so equip/unequip mid-session is reflected", () => {
    const meshes = new Map<PlayerId, THREE.Mesh>();
    meshes.set(1, bodyMesh());
    const mat = meshes.get(1)!.material as THREE.MeshLambertMaterial;

    applyLanternGlow(meshes, [entity(1, ItemId.Lantern)]);
    expect(mat.emissive.getHex()).toBe(0xffffff);

    applyLanternGlow(meshes, [entity(1, null)]);
    expect(mat.emissive.getHex()).toBe(0x000000);
    expect(mat.emissiveIntensity).toBe(0);

    applyLanternGlow(meshes, [entity(1, ItemId.Lantern)]);
    expect(mat.emissive.getHex()).toBe(0xffffff);
  });

  it("treats non-lantern utility items as 'no glow'", () => {
    const meshes = new Map<PlayerId, THREE.Mesh>();
    meshes.set(1, bodyMesh());
    applyLanternGlow(meshes, [entity(1, ItemId.Torch)]);
    const mat = meshes.get(1)!.material as THREE.MeshLambertMaterial;
    expect(mat.emissive.getHex()).toBe(0x000000);
  });

  it("silently skips materials without an emissive field (e.g. MeshBasicMaterial test factories)", () => {
    const basic = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff00ff }),
    );
    const meshes = new Map<PlayerId, THREE.Mesh>([[1, basic]]);
    expect(() =>
      applyLanternGlow(meshes, [entity(1, ItemId.Lantern)]),
    ).not.toThrow();
  });
});
