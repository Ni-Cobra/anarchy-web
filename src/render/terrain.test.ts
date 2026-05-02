import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  BlockType,
  CHUNK_SIZE,
  Terrain,
  emptyChunk,
  setBlock,
} from "../game/index.js";
import { buildTerrainMesh, disposeTerrainMesh, tileCenterToScene } from "./terrain.js";

describe("tileCenterToScene", () => {
  it("centers tile (0,0) in chunk (0,0) at world (0.5, 0.5) → scene (0.5, -0.5)", () => {
    expect(tileCenterToScene(0, 0, 0, 0)).toEqual({ x: 0.5, z: -0.5 });
  });

  it("centers the SW corner of chunk (0,0) at world (0.5, 0.5) — origin convention", () => {
    // ADR 0002: world origin sits at the shared corner of the four default
    // chunks. The first tile of chunk (0,0) is just NE of origin.
    const s = tileCenterToScene(0, 0, 0, 0);
    expect(s.x).toBeGreaterThan(0);
    expect(s.z).toBeLessThan(0);
  });

  it("flips world +y to scene -z", () => {
    // Two tiles only differing in world-y land at scene positions only
    // differing in -z (mirrors `tileToScene` for the player mesh).
    const a = tileCenterToScene(0, 0, 5, 3);
    const b = tileCenterToScene(0, 0, 5, 8);
    expect(a.x).toBe(b.x);
    expect(b.z - a.z).toBeCloseTo(-(8 - 3));
  });

  it("chunk-coord shifts by CHUNK_SIZE per chunk step", () => {
    const inOrigin = tileCenterToScene(0, 0, 0, 0);
    const inEast = tileCenterToScene(1, 0, 0, 0);
    const inNorth = tileCenterToScene(0, 1, 0, 0);
    expect(inEast.x - inOrigin.x).toBeCloseTo(CHUNK_SIZE);
    // World +y → scene -z, so a chunk step in +y means scene z drops by
    // CHUNK_SIZE.
    expect(inNorth.z - inOrigin.z).toBeCloseTo(-CHUNK_SIZE);
  });

  it("negative chunk coords land in the south-west of origin", () => {
    const s = tileCenterToScene(-1, -1, 15, 15);
    // Chunk (-1, -1) covers tiles -16 .. 0; its NE corner tile (15, 15)
    // covers world tiles -1..0 in both axes. Center: (-0.5, -0.5).
    expect(s.x).toBeCloseTo(-0.5);
    expect(s.z).toBeCloseTo(0.5);
  });
});

describe("buildTerrainMesh", () => {
  it("empty terrain produces an empty group", () => {
    const t = new Terrain();
    const g = buildTerrainMesh(t);
    expect(g.children).toHaveLength(0);
    disposeTerrainMesh(g);
  });

  it("each loaded chunk becomes one named sub-group", () => {
    const t = new Terrain();
    t.insert(0, 0, emptyChunk());
    t.insert(-1, 2, emptyChunk());
    const g = buildTerrainMesh(t);
    expect(g.children).toHaveLength(2);
    const names = g.children.map((c) => c.name).sort();
    expect(names).toEqual(["chunk:-1,2", "chunk:0,0"]);
    disposeTerrainMesh(g);
  });

  it("non-Air ground blocks become tile meshes; Air ground blocks do not", () => {
    const c = emptyChunk();
    setBlock(c.ground, 3, 4, { kind: BlockType.Grass });
    setBlock(c.ground, 5, 6, { kind: BlockType.Stone });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const chunkGroup = g.children[0]!;
    // Two ground tiles only. Top layer is all Air → no top meshes.
    expect(chunkGroup.children).toHaveLength(2);
    for (const m of chunkGroup.children) {
      expect(m).toBeInstanceOf(THREE.Mesh);
    }
    disposeTerrainMesh(g);
  });

  it("non-Air top blocks become upright meshes positioned above the ground", () => {
    const c = emptyChunk();
    setBlock(c.top, 7, 8, { kind: BlockType.Wood });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const chunkGroup = g.children[0]!;
    // Only the top block (ground is all Air → no ground tiles).
    expect(chunkGroup.children).toHaveLength(1);
    const mesh = chunkGroup.children[0]! as THREE.Mesh;
    // Center of tile (7, 8) in chunk (0, 0): world (7.5, 8.5) → scene (7.5, *, -8.5).
    expect(mesh.position.x).toBeCloseTo(7.5);
    expect(mesh.position.z).toBeCloseTo(-8.5);
    // Y is above the ground slab — pinning "above zero" is the load-
    // bearing invariant; exact value is a visual choice.
    expect(mesh.position.y).toBeGreaterThan(0);
    disposeTerrainMesh(g);
  });

  it("top-layer blocks share the full unit-cell XZ footprint with ground tiles", () => {
    // A top block must occupy the same XZ extent as a ground tile so it
    // visually fills the cell — only vertical extent and layer differ.
    const c = emptyChunk();
    setBlock(c.ground, 2, 3, { kind: BlockType.Grass });
    setBlock(c.top, 4, 5, { kind: BlockType.Wood });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    expect(meshes).toHaveLength(2);
    const groundMesh = meshes.find((m) => m.position.y < 0.5)!;
    const topMesh = meshes.find((m) => m.position.y >= 0.5)!;
    const groundParams = (groundMesh.geometry as THREE.BoxGeometry).parameters;
    const topParams = (topMesh.geometry as THREE.BoxGeometry).parameters;
    expect(topParams.width).toBeCloseTo(groundParams.width);
    expect(topParams.depth).toBeCloseTo(groundParams.depth);
    disposeTerrainMesh(g);
  });

  it("blocks of the same kind in one chunk share their material", () => {
    // Material cache is per-chunk; pin the dedupe so a future change
    // doesn't accidentally allocate one material per tile.
    const c = emptyChunk();
    setBlock(c.ground, 0, 0, { kind: BlockType.Grass });
    setBlock(c.ground, 1, 0, { kind: BlockType.Grass });
    setBlock(c.ground, 2, 0, { kind: BlockType.Grass });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    expect(meshes).toHaveLength(3);
    expect(meshes[0]!.material).toBe(meshes[1]!.material);
    expect(meshes[1]!.material).toBe(meshes[2]!.material);
    disposeTerrainMesh(g);
  });
});

describe("disposeTerrainMesh", () => {
  it("disposes each unique geometry and material exactly once", () => {
    // Build a chunk where many tiles share material+geometry so the
    // dedupe path is exercised.
    const c = emptyChunk();
    for (let x = 0; x < 16; x++) {
      setBlock(c.ground, x, 0, { kind: BlockType.Grass });
    }
    setBlock(c.top, 5, 0, { kind: BlockType.Wood });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);

    // Collect every unique geom + mat reachable, attach a counting spy.
    const uniqueGeoms = new Set<THREE.BufferGeometry>();
    const uniqueMats = new Set<THREE.Material>();
    const calls: string[] = [];
    g.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      uniqueGeoms.add(obj.geometry);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) uniqueMats.add(m);
    });
    for (const geom of uniqueGeoms) {
      const tag = `geom:${geom.uuid}`;
      const orig = geom.dispose.bind(geom);
      geom.dispose = () => {
        calls.push(tag);
        orig();
      };
    }
    for (const mat of uniqueMats) {
      const tag = `mat:${mat.uuid}`;
      const orig = mat.dispose.bind(mat);
      mat.dispose = () => {
        calls.push(tag);
        orig();
      };
    }

    disposeTerrainMesh(g);
    // Each unique resource fired exactly once.
    expect(calls.length).toBe(uniqueGeoms.size + uniqueMats.size);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("removes the group from its parent if one is given", () => {
    const parent = new THREE.Group();
    const t = new Terrain();
    t.insert(0, 0, emptyChunk());
    const g = buildTerrainMesh(t);
    parent.add(g);
    expect(parent.children).toContain(g);
    disposeTerrainMesh(g, parent);
    expect(parent.children).not.toContain(g);
  });
});
