import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { ItemId, type PlayerId } from "../game/index.js";
import {
  BODY_LIT_MAT_USERDATA_KEY,
  BODY_UNLIT_MAT_USERDATA_KEY,
  applyLanternBodyUnlit,
  type LanternGlowEntity,
} from "./player_mesh.js";

interface BodyMesh {
  mesh: THREE.Mesh;
  lit: THREE.MeshLambertMaterial;
  unlit: THREE.MeshBasicMaterial;
}

function bodyMesh(): BodyMesh {
  const lit = new THREE.MeshLambertMaterial({ color: 0x808080 });
  const unlit = new THREE.MeshBasicMaterial({ color: 0x808080 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), lit);
  mesh.userData[BODY_LIT_MAT_USERDATA_KEY] = lit;
  mesh.userData[BODY_UNLIT_MAT_USERDATA_KEY] = unlit;
  return { mesh, lit, unlit };
}

const entity = (id: PlayerId, equippedUtility: ItemId | null): LanternGlowEntity => ({
  id,
  equippedUtility,
});

describe("applyLanternBodyUnlit", () => {
  it("swaps to the unlit body material for lantern-wearers, leaves others lit", () => {
    const a = bodyMesh();
    const b = bodyMesh();
    const meshes = new Map<PlayerId, THREE.Mesh>([
      [1, a.mesh],
      [2, b.mesh],
    ]);

    applyLanternBodyUnlit(meshes, [
      entity(1, ItemId.Lantern),
      entity(2, null),
    ]);

    expect(a.mesh.material).toBe(a.unlit);
    expect(a.mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(b.mesh.material).toBe(b.lit);
    expect(b.mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
  });

  it("re-applies each call so equip/unequip mid-session is reflected", () => {
    const a = bodyMesh();
    const meshes = new Map<PlayerId, THREE.Mesh>([[1, a.mesh]]);

    applyLanternBodyUnlit(meshes, [entity(1, ItemId.Lantern)]);
    expect(a.mesh.material).toBe(a.unlit);

    applyLanternBodyUnlit(meshes, [entity(1, null)]);
    expect(a.mesh.material).toBe(a.lit);

    applyLanternBodyUnlit(meshes, [entity(1, ItemId.Lantern)]);
    expect(a.mesh.material).toBe(a.unlit);
  });

  it("treats non-lantern utility items as 'no glow' (stays lit)", () => {
    const a = bodyMesh();
    const meshes = new Map<PlayerId, THREE.Mesh>([[1, a.mesh]]);
    applyLanternBodyUnlit(meshes, [entity(1, ItemId.Torch)]);
    expect(a.mesh.material).toBe(a.lit);
  });

  it("silently skips meshes that didn't stash both materials (test factories etc.)", () => {
    const bare = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff00ff }),
    );
    const original = bare.material;
    const meshes = new Map<PlayerId, THREE.Mesh>([[1, bare]]);
    expect(() =>
      applyLanternBodyUnlit(meshes, [entity(1, ItemId.Lantern)]),
    ).not.toThrow();
    expect(bare.material).toBe(original);
  });
});
