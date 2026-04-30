import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { World, type Player } from "../game/index.js";
import {
  disposePlayerMesh,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
} from "./sync.js";

const p = (id: number, x = 0, y = 0): Player => ({ id, x, y });

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
  it("creates a mesh for each new player and adds it to the parent", () => {
    const world = new World();
    world.applySnapshot([p(1, 2, 3), p(2, -1, 0)]);
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes(world, 1, meshes, parent, factory);

    expect(meshes.size).toBe(2);
    expect(parent.children).toHaveLength(2);
    expectVec(meshes.get(1)!.position, 2, 0.5, -3);
    expectVec(meshes.get(2)!.position, -1, 0.5, 0);
    expect(calls).toEqual([
      { id: 1, isLocal: true },
      { id: 2, isLocal: false },
    ]);
  });

  it("updates positions for existing players without recreating meshes", () => {
    const world = new World();
    world.applySnapshot([p(1, 0, 0)]);
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes(world, 1, meshes, parent, factory);
    const original = meshes.get(1)!;

    world.applySnapshot([p(1, 5, -7)]);
    syncPlayerMeshes(world, 1, meshes, parent, factory);

    expect(meshes.get(1)).toBe(original);
    expectVec(original.position, 5, 0.5, 7);
    expect(parent.children).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("removes and disposes meshes for players no longer in the world", () => {
    const world = new World();
    world.applySnapshot([p(1), p(2)]);
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory } = recordingFactory();

    syncPlayerMeshes(world, null, meshes, parent, factory);
    const stale = meshes.get(2)!;
    let disposed = false;
    stale.geometry.addEventListener("dispose", () => {
      disposed = true;
    });

    world.applySnapshot([p(1)]);
    syncPlayerMeshes(world, null, meshes, parent, factory);

    expect(meshes.has(2)).toBe(false);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBe(meshes.get(1));
    expect(disposed).toBe(true);
  });

  it("flags only the local player id as local", () => {
    const world = new World();
    world.applySnapshot([p(7), p(8), p(9)]);
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes(world, 8, meshes, parent, factory);

    const localCalls = calls.filter((c) => c.isLocal);
    expect(localCalls).toEqual([{ id: 8, isLocal: true }]);
  });

  it("handles a null local id (everyone is remote)", () => {
    const world = new World();
    world.applySnapshot([p(1), p(2)]);
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory, calls } = recordingFactory();

    syncPlayerMeshes(world, null, meshes, parent, factory);

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
