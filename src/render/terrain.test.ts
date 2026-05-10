import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  BlockType,
  CHUNK_SIZE,
  Terrain,
  emptyChunk,
  setBlock,
} from "../game/index.js";
import {
  buildChunkMesh,
  buildTerrainMesh,
  disposeTerrainMesh,
  tileCenterToScene,
  torchPositionsInChunk,
} from "./terrain.js";

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

describe("Torch top-layer rendering (task 350)", () => {
  it("renders a Torch as a thin upright transparent mesh, not a full cell", () => {
    const c = emptyChunk();
    setBlock(c.top, 7, 8, { kind: BlockType.Torch });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    expect(meshes).toHaveLength(1);
    const torch = meshes[0]!;
    const params = (torch.geometry as THREE.BoxGeometry).parameters;
    // A torch is *not* a full unit cell — that's the load-bearing
    // affordance for "non-solid, walk-through".
    expect(params.width).toBeLessThan(1);
    expect(params.depth).toBeLessThan(1);
    // No-texture test path: material falls back to a plain solid color
    // (transparent + alphaTest only fire on the textured path), but the
    // mesh must still be positioned and shaped like a torch.
    expect(torch.position.x).toBeCloseTo(7.5);
    expect(torch.position.z).toBeCloseTo(-8.5);
    expect(torch.position.y).toBeGreaterThan(0);
    disposeTerrainMesh(g);
  });
});

describe("torchPositionsInChunk", () => {
  it("returns scene-space centers for every Torch top-layer cell", () => {
    const c = emptyChunk();
    setBlock(c.top, 0, 0, { kind: BlockType.Torch });
    setBlock(c.top, 5, 3, { kind: BlockType.Torch });
    // A non-Torch top block must be ignored.
    setBlock(c.top, 1, 1, { kind: BlockType.Wood });
    const positions = torchPositionsInChunk(0, 0, c);
    expect(positions).toHaveLength(2);
    const sorted = [...positions].sort((a, b) => a.x - b.x);
    expect(sorted[0]).toEqual(tileCenterToScene(0, 0, 0, 0));
    expect(sorted[1]).toEqual(tileCenterToScene(0, 0, 5, 3));
  });

  it("offsets by chunk coord", () => {
    const c = emptyChunk();
    setBlock(c.top, 0, 0, { kind: BlockType.Torch });
    const positions = torchPositionsInChunk(2, -1, c);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(tileCenterToScene(2, -1, 0, 0));
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

describe("Hidden-adjacent AO (task 290)", () => {
  // Helpers for the AO assertions: vertex colors are baked on the +y face
  // of cloned BoxGeometries, so reading the `color` attribute pins the
  // shader-side behavior without a real GL context.
  const topFaceColors = (mesh: THREE.Mesh): number[] => {
    const color = mesh.geometry.getAttribute("color");
    expect(color).toBeDefined();
    // BoxGeometry duplicates each corner per face; pick only the +y-face
    // copies via the per-vertex normal so we read exactly four samples.
    const normals = mesh.geometry.getAttribute("normal");
    const out: number[] = [];
    for (let i = 0; i < normals.count; i++) {
      if (normals.getY(i) > 0.5) out.push(color.getX(i));
    }
    return out;
  };

  it("a top block with no Hidden neighbour uses the shared default geometry", () => {
    const c = emptyChunk();
    setBlock(c.top, 5, 5, { kind: BlockType.Stone });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.geometry.getAttribute("color")).toBeUndefined();
    disposeTerrainMesh(g);
  });

  it("a top block with a Hidden neighbour gets a top-face vertex-color bake", () => {
    const c = emptyChunk();
    setBlock(c.top, 5, 5, { kind: BlockType.Stone });
    setBlock(c.top, 6, 5, { kind: BlockType.Hidden });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    const stone = meshes.find((m) => Math.abs(m.position.x - 5.5) < 1e-3)!;
    expect(stone).toBeDefined();
    const top = topFaceColors(stone);
    // Four corners on the top face; the two on the +x edge (touching the
    // Hidden cell to the east) darken, the other two stay white.
    const dark = top.filter((c) => c < 0.5).length;
    const bright = top.filter((c) => c > 0.99).length;
    expect(dark).toBe(2);
    expect(bright).toBe(2);
    disposeTerrainMesh(g);
  });

  it("two Hidden neighbours stack on the shared corner", () => {
    const c = emptyChunk();
    setBlock(c.top, 5, 5, { kind: BlockType.Stone });
    setBlock(c.top, 6, 5, { kind: BlockType.Hidden });
    setBlock(c.top, 5, 6, { kind: BlockType.Hidden });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    const stone = meshes.find((m) => Math.abs(m.position.x - 5.5) < 1e-3)!;
    const top = topFaceColors(stone);
    // One corner is in the pinch (+x AND +y world / -z scene Hidden) so it
    // multiplies twice; two corners darken once; one stays white.
    const sorted = [...top].sort((a, b) => a - b);
    expect(sorted[0]!).toBeLessThan(0.1); // double-darkened
    expect(sorted[1]!).toBeLessThan(0.5); // single-darkened
    expect(sorted[2]!).toBeLessThan(0.5); // single-darkened
    expect(sorted[3]!).toBeGreaterThan(0.99); // un-darkened
    disposeTerrainMesh(g);
  });

  it("Hidden neighbour in an unloaded chunk leaves the edge unshaded", () => {
    // Cell (15, 5) sits on the eastern border of chunk (0, 0); its east
    // neighbour lives in chunk (1, 0) which we never load.
    const c = emptyChunk();
    setBlock(c.top, 15, 5, { kind: BlockType.Stone });
    const t = new Terrain();
    t.insert(0, 0, c);
    const g = buildTerrainMesh(t);
    const meshes = g.children[0]!.children as THREE.Mesh[];
    expect(meshes).toHaveLength(1);
    // No Hidden neighbour visible → falls back to the shared geometry.
    expect(meshes[0]!.geometry.getAttribute("color")).toBeUndefined();
    disposeTerrainMesh(g);
  });

  it("Hidden neighbour across a loaded chunk border darkens the right edge", () => {
    const here = emptyChunk();
    setBlock(here.top, 15, 5, { kind: BlockType.Stone });
    const east = emptyChunk();
    setBlock(east.top, 0, 5, { kind: BlockType.Hidden });
    const t = new Terrain();
    t.insert(0, 0, here);
    t.insert(1, 0, east);
    const g = buildTerrainMesh(t);
    const stone = (g.children.find((c) => c.name === "chunk:0,0")!
      .children[0]) as THREE.Mesh;
    const top = topFaceColors(stone);
    expect(top.filter((c) => c < 0.5).length).toBe(2);
    expect(top.filter((c) => c > 0.99).length).toBe(2);
    disposeTerrainMesh(g);
  });

  it("buildChunkMesh without a terrain treats every off-chunk neighbour as not Hidden", () => {
    // Border cell, no terrain reference → no AO even though the spec would
    // care if a neighbour chunk were loaded. Mirrors the test-only path.
    const c = emptyChunk();
    setBlock(c.top, 15, 5, { kind: BlockType.Stone });
    const g = buildChunkMesh(0, 0, c);
    expect(g.children).toHaveLength(1);
    expect((g.children[0] as THREE.Mesh).geometry.getAttribute("color")).toBeUndefined();
    disposeTerrainMesh(g);
  });
});
