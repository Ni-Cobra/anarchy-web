import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  BlockType,
  Terrain,
  emptyChunk,
  setBlock,
} from "../game/index.js";
import { pickBlockUnderCursor } from "./picker.js";

/**
 * Top-down perspective camera positioned so NDC `(0, 0)` points straight
 * down at world `(worldX, worldY)`. Mirrors the in-game camera setup
 * (`up = (0, 0, -1)`, look-at on the local player) closely enough that
 * shifting the camera is the test's lever for "where the cursor lands".
 */
function topDownCameraAt(
  worldX: number,
  worldY: number,
  height = 14,
): THREE.PerspectiveCamera {
  const sceneX = worldX;
  const sceneZ = -worldY;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.up.set(0, 0, -1);
  camera.position.set(sceneX, height, sceneZ);
  camera.lookAt(sceneX, 0, sceneZ);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

const NDC_CENTER = { x: 0, y: 0 };

describe("pickBlockUnderCursor", () => {
  it("returns the ground tile for a cell with only ground", () => {
    const chunk = emptyChunk();
    setBlock(chunk.ground, 5, 5, { kind: BlockType.Grass });
    const terrain = new Terrain();
    terrain.insert(0, 0, chunk);

    const result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(5.5, 5.5),
      terrain,
    );

    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([0, 0]);
    expect(result!.localXY).toEqual([5, 5]);
    expect(result!.layer).toBe("ground");
    expect(result!.block.kind).toBe(BlockType.Grass);
  });

  it("returns the top block when one exists at the cell", () => {
    const chunk = emptyChunk();
    setBlock(chunk.ground, 5, 5, { kind: BlockType.Grass });
    setBlock(chunk.top, 5, 5, { kind: BlockType.Wood });
    const terrain = new Terrain();
    terrain.insert(0, 0, chunk);

    const result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(5.5, 5.5),
      terrain,
    );

    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([0, 0]);
    expect(result!.localXY).toEqual([5, 5]);
    expect(result!.layer).toBe("top");
    expect(result!.block.kind).toBe(BlockType.Wood);
  });

  it("returns null when no chunks are loaded", () => {
    const terrain = new Terrain();

    const result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(5.5, 5.5),
      terrain,
    );

    expect(result).toBeNull();
  });

  it("returns null when the cursor falls outside any loaded chunk", () => {
    const terrain = new Terrain();
    terrain.insert(0, 0, emptyChunk());

    // World (20.5, 5.5) is in chunk (1, 0), which isn't loaded.
    const result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(20.5, 5.5),
      terrain,
    );

    expect(result).toBeNull();
  });

  it("returns null when the camera ray points away from the y=0 plane", () => {
    const terrain = new Terrain();
    terrain.insert(0, 0, emptyChunk());

    // Camera above the ground plane, looking further up — the ray's
    // intersection with `y = 0` is behind the origin, so `Ray.intersectPlane`
    // returns null.
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 100, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const result = pickBlockUnderCursor(NDC_CENTER, camera, terrain);

    expect(result).toBeNull();
  });

  it("picks the last cell of a chunk and the first cell of its eastern neighbor at the boundary", () => {
    const c00 = emptyChunk();
    setBlock(c00.top, 15, 0, { kind: BlockType.Wood });
    const c10 = emptyChunk();
    setBlock(c10.top, 0, 0, { kind: BlockType.Stone });
    const terrain = new Terrain();
    terrain.insert(0, 0, c00);
    terrain.insert(1, 0, c10);

    // Center of chunk (0, 0)'s last column — world (15.5, 0.5).
    let result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(15.5, 0.5),
      terrain,
    );
    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([0, 0]);
    expect(result!.localXY).toEqual([15, 0]);
    expect(result!.layer).toBe("top");
    expect(result!.block.kind).toBe(BlockType.Wood);

    // One tile east — world (16.5, 0.5), chunk (1, 0)'s first column.
    result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(16.5, 0.5),
      terrain,
    );
    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([1, 0]);
    expect(result!.localXY).toEqual([0, 0]);
    expect(result!.layer).toBe("top");
    expect(result!.block.kind).toBe(BlockType.Stone);
  });

  it("picks the last cell of a chunk and the first cell of its northern neighbor at the boundary", () => {
    const c00 = emptyChunk();
    setBlock(c00.ground, 0, 15, { kind: BlockType.Grass });
    const c01 = emptyChunk();
    setBlock(c01.ground, 0, 0, { kind: BlockType.Stone });
    const terrain = new Terrain();
    terrain.insert(0, 0, c00);
    terrain.insert(0, 1, c01);

    // World (0.5, 15.5) — last row of chunk (0, 0).
    let result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(0.5, 15.5),
      terrain,
    );
    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([0, 0]);
    expect(result!.localXY).toEqual([0, 15]);
    expect(result!.block.kind).toBe(BlockType.Grass);

    // World (0.5, 16.5) — first row of chunk (0, 1).
    result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(0.5, 16.5),
      terrain,
    );
    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([0, 1]);
    expect(result!.localXY).toEqual([0, 0]);
    expect(result!.block.kind).toBe(BlockType.Stone);
  });

  it("handles negative chunk coords (south-west of origin)", () => {
    const chunk = emptyChunk();
    setBlock(chunk.ground, 15, 15, { kind: BlockType.Grass });
    const terrain = new Terrain();
    terrain.insert(-1, -1, chunk);

    // World (-0.5, -0.5) → tile (-1, -1) → chunk (-1, -1) local (15, 15).
    const result = pickBlockUnderCursor(
      NDC_CENTER,
      topDownCameraAt(-0.5, -0.5),
      terrain,
    );

    expect(result).not.toBeNull();
    expect(result!.chunkCoord).toEqual([-1, -1]);
    expect(result!.localXY).toEqual([15, 15]);
    expect(result!.layer).toBe("ground");
    expect(result!.block.kind).toBe(BlockType.Grass);
  });

  it("uses the cursor NDC to direct the ray (off-center cursor lands off-axis)", () => {
    // Ortho camera with a known XZ extent makes NDC → world a clean,
    // trig-free mapping: NDC (1, 0) shifts the hit by `half_width` along
    // the camera's right axis (world +x with `up = (0, 0, -1)`).
    const chunk = emptyChunk();
    setBlock(chunk.ground, 5, 5, { kind: BlockType.Grass });
    setBlock(chunk.ground, 10, 5, { kind: BlockType.Stone });
    const terrain = new Terrain();
    terrain.insert(0, 0, chunk);

    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.up.set(0, 0, -1);
    camera.position.set(5.5, 14, -5.5);
    camera.lookAt(5.5, 0, -5.5);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    // NDC (0, 0) → world (5.5, 5.5) → tile (5, 5).
    let result = pickBlockUnderCursor({ x: 0, y: 0 }, camera, terrain);
    expect(result).not.toBeNull();
    expect(result!.localXY).toEqual([5, 5]);
    expect(result!.block.kind).toBe(BlockType.Grass);

    // NDC (0.9, 0) → world (≈10, 5.5) → tile (10, 5).
    result = pickBlockUnderCursor({ x: 0.9, y: 0 }, camera, terrain);
    expect(result).not.toBeNull();
    expect(result!.localXY).toEqual([10, 5]);
    expect(result!.block.kind).toBe(BlockType.Stone);
  });
});
