import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
  type RenderableEntity,
} from "./sync.js";

const e = (id: number, x = 0, y = 0): RenderableEntity => ({ id, x, y });

interface FactoryCall {
  id: number;
  isLocal: boolean;
}

function recordingFactory(): { factory: PlayerMeshFactory; calls: FactoryCall[] } {
  const calls: FactoryCall[] = [];
  const factory: PlayerMeshFactory = {
    create(player, isLocal) {
      calls.push({ id: player.id, isLocal });
      return new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: isLocal ? 0xff0000 : 0x0000ff }),
      );
    },
  };
  return { factory, calls };
}

function expectVec(v: THREE.Vector3, x: number, y: number, z: number) {
  // toBeCloseTo treats +0 and -0 as equal (the diff is zero), unlike toEqual
  // which uses Object.is and trips on `-y` when y === 0.
  expect(v.x).toBeCloseTo(x);
  expect(v.y).toBeCloseTo(y);
  expect(v.z).toBeCloseTo(z);
}

describe("tileToScene", () => {
  it("maps server (+x east, +y north) to scene (x, 0.5, -y)", () => {
    expectVec(tileToScene(0, 0), 0, 0.5, 0);
    expectVec(tileToScene(3, 4), 3, 0.5, -4);
    expectVec(tileToScene(-2, -5), -2, 0.5, 5);
  });
});

describe("syncPlayerMeshes", () => {
  it("creates a mesh for each new entity and adds it to the parent", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes([e(1, 2, 3), e(2, -1, 0)], 1, meshes, parent, factory);

    expect(meshes.size).toBe(2);
    expect(parent.children).toHaveLength(2);
    expectVec(meshes.get(1)!.position, 2, 0.5, -3);
    expectVec(meshes.get(2)!.position, -1, 0.5, 0);
    expect(calls).toEqual([
      { id: 1, isLocal: true },
      { id: 2, isLocal: false },
    ]);
  });

  it("updates positions for existing entities without recreating meshes", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes([e(1, 0, 0)], 1, meshes, parent, factory);
    const original = meshes.get(1)!;

    syncPlayerMeshes([e(1, 5, -7)], 1, meshes, parent, factory);

    expect(meshes.get(1)).toBe(original);
    expectVec(original.position, 5, 0.5, 7);
    expect(parent.children).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("accepts non-integer coords (interpolated remote positions)", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory } = recordingFactory();

    syncPlayerMeshes([e(1, 2.5, -3.25)], null, meshes, parent, factory);

    expectVec(meshes.get(1)!.position, 2.5, 0.5, 3.25);
  });

  it("removes and disposes meshes for entities no longer present", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory } = recordingFactory();

    syncPlayerMeshes([e(1), e(2)], null, meshes, parent, factory);
    const stale = meshes.get(2)!;
    let disposed = false;
    stale.geometry.addEventListener("dispose", () => {
      disposed = true;
    });

    syncPlayerMeshes([e(1)], null, meshes, parent, factory);

    expect(meshes.has(2)).toBe(false);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBe(meshes.get(1));
    expect(disposed).toBe(true);
  });

  it("flags only the local player id as local", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes([e(7), e(8), e(9)], 8, meshes, parent, factory);

    const localCalls = calls.filter((c) => c.isLocal);
    expect(localCalls).toEqual([{ id: 8, isLocal: true }]);
  });

  it("handles a null local id (everyone is remote)", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes([e(1), e(2)], null, meshes, parent, factory);

    expect(calls.every((c) => c.isLocal === false)).toBe(true);
  });
});

describe("disposePlayerMesh", () => {
  it("removes the mesh from its parent and disposes geometry + material", () => {
    const parent = new THREE.Group();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);

    let geomDisposed = false;
    let matDisposed = false;
    geometry.addEventListener("dispose", () => {
      geomDisposed = true;
    });
    material.addEventListener("dispose", () => {
      matDisposed = true;
    });

    disposePlayerMesh(mesh, parent);

    expect(parent.children).toHaveLength(0);
    expect(geomDisposed).toBe(true);
    expect(matDisposed).toBe(true);
  });
});
