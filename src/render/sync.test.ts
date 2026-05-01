import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { Direction8 } from "../game/index.js";
import {
  disposePlayerMesh,
  facingToYaw,
  syncPlayerMeshes,
  tileToScene,
  type PlayerMeshFactory,
  type RenderableEntity,
} from "./sync.js";

const e = (
  id: number,
  x = 0,
  y = 0,
  facing: Direction8 = Direction8.S,
): RenderableEntity => ({ id, x, y, facing });

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

describe("facingToYaw", () => {
  // Front-of-mesh convention: local +X is the player's forward. After
  // applying yaw, that forward should align with the requested compass
  // direction in scene XZ (server +y north = scene -z).
  it("returns 0 for east (front already along +X)", () => {
    expect(facingToYaw(Direction8.E)).toBeCloseTo(0);
  });

  it("rotates north to scene -Z (a quarter-turn CCW around Y)", () => {
    // R_y(π/2) sends (1, 0, 0) → (0, 0, -1), which is scene north.
    const yaw = facingToYaw(Direction8.N);
    const forward = new THREE.Vector3(1, 0, 0).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    expectVec(forward, 0, 0, -1);
  });

  it("rotates west to scene -X", () => {
    const yaw = facingToYaw(Direction8.W);
    const forward = new THREE.Vector3(1, 0, 0).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    expectVec(forward, -1, 0, 0);
  });

  it("rotates south to scene +Z", () => {
    const yaw = facingToYaw(Direction8.S);
    const forward = new THREE.Vector3(1, 0, 0).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    expectVec(forward, 0, 0, 1);
  });

  it("places diagonals on the right diagonals of the unit circle", () => {
    const cases: Array<[Direction8, number, number]> = [
      [Direction8.NE, Math.SQRT1_2, -Math.SQRT1_2],
      [Direction8.NW, -Math.SQRT1_2, -Math.SQRT1_2],
      [Direction8.SE, Math.SQRT1_2, Math.SQRT1_2],
      [Direction8.SW, -Math.SQRT1_2, Math.SQRT1_2],
    ];
    for (const [dir, x, z] of cases) {
      const yaw = facingToYaw(dir);
      const forward = new THREE.Vector3(1, 0, 0).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yaw,
      );
      expectVec(forward, x, 0, z);
    }
  });

  it("maps every Direction8 value to a finite yaw", () => {
    for (const dir of [
      Direction8.N,
      Direction8.NE,
      Direction8.E,
      Direction8.SE,
      Direction8.S,
      Direction8.SW,
      Direction8.W,
      Direction8.NW,
    ]) {
      expect(Number.isFinite(facingToYaw(dir))).toBe(true);
    }
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

  it("syncs mesh.rotation.y from entity facing each frame", () => {
    const meshes = new Map<number, THREE.Mesh>();
    const parent = new THREE.Group();
    const { factory } = recordingFactory();

    syncPlayerMeshes([e(1, 0, 0, Direction8.N)], 1, meshes, parent, factory);
    expect(meshes.get(1)!.rotation.y).toBeCloseTo(facingToYaw(Direction8.N));

    syncPlayerMeshes([e(1, 0, 0, Direction8.W)], 1, meshes, parent, factory);
    expect(meshes.get(1)!.rotation.y).toBeCloseTo(facingToYaw(Direction8.W));
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

  it("recurses into child meshes (e.g. eye meshes parented to the body)", () => {
    const parent = new THREE.Group();
    const bodyGeom = new THREE.SphereGeometry(0.5);
    const bodyMat = new THREE.MeshBasicMaterial();
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    const eyeGeom = new THREE.SphereGeometry(0.1);
    const eyeMat = new THREE.MeshBasicMaterial();
    body.add(new THREE.Mesh(eyeGeom, eyeMat));
    body.add(new THREE.Mesh(eyeGeom, eyeMat));
    parent.add(body);

    let bodyGeomDisposed = false;
    let eyeGeomDisposed = 0;
    let eyeMatDisposed = 0;
    bodyGeom.addEventListener("dispose", () => {
      bodyGeomDisposed = true;
    });
    // The two eye meshes share one geometry + material instance (the
    // factory pattern in the renderer). Disposal should fire exactly once
    // per shared resource, not once per child mesh.
    eyeGeom.addEventListener("dispose", () => {
      eyeGeomDisposed += 1;
    });
    eyeMat.addEventListener("dispose", () => {
      eyeMatDisposed += 1;
    });

    disposePlayerMesh(body, parent);

    expect(parent.children).toHaveLength(0);
    expect(bodyGeomDisposed).toBe(true);
    expect(eyeGeomDisposed).toBe(1);
    expect(eyeMatDisposed).toBe(1);
  });
});
