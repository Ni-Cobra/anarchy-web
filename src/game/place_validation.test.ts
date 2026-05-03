import { describe, expect, it } from "vitest";

import { canPlaceTopBlock } from "./place_validation.js";
import { DEFAULT_FACING, Direction8, type Player } from "./player.js";
import {
  BlockType,
  CHUNK_SIZE,
  Terrain,
  emptyChunk,
  setBlock,
} from "./terrain.js";
import { World } from "./world.js";

const me = (
  id: number,
  x: number,
  y: number,
  facing: Direction8 = DEFAULT_FACING,
): Player => ({ id, x, y, facing, username: "", colorIndex: 0 });

function setup(local: Player, others: Player[] = []): { world: World; terrain: Terrain } {
  const world = new World();
  world.applySnapshot([local, ...others]);
  const terrain = new Terrain();
  terrain.insert(0, 0, emptyChunk());
  return { world, terrain };
}

describe("canPlaceTopBlock", () => {
  it("returns false when there is no local player id", () => {
    const { world, terrain } = setup(me(1, 0.5, 0.5));
    expect(canPlaceTopBlock(world, terrain, null, 0, 0, 1, 0)).toBe(false);
  });

  it("returns false when the local player is not in the world", () => {
    const { world, terrain } = setup(me(1, 0.5, 0.5));
    expect(canPlaceTopBlock(world, terrain, 99, 0, 0, 1, 0)).toBe(false);
  });

  it("returns false when the targeted chunk is not loaded", () => {
    const { world, terrain } = setup(me(1, 0.5, 0.5));
    expect(canPlaceTopBlock(world, terrain, 1, 5, 5, 0, 0)).toBe(false);
  });

  it("returns true for an in-reach empty top cell", () => {
    const { world, terrain } = setup(me(1, 0.5, 0.5));
    expect(canPlaceTopBlock(world, terrain, 1, 0, 0, 2, 0)).toBe(true);
  });

  it("returns false when the top cell already holds a block", () => {
    const { world, terrain } = setup(me(1, 0.5, 0.5));
    const chunk = terrain.get(0, 0)!;
    setBlock(chunk.top, 2, 0, { kind: BlockType.Wood });
    expect(canPlaceTopBlock(world, terrain, 1, 0, 0, 2, 0)).toBe(false);
  });

  it("returns false when the target tile is out of REACH_BLOCKS", () => {
    const { world, terrain } = setup(me(1, 0.5, 0.5));
    // Tile (10, 0) center is at (10.5, 0.5) — Euclidean distance ~10 from
    // the player at (0.5, 0.5), well beyond REACH_BLOCKS = 4.0.
    expect(canPlaceTopBlock(world, terrain, 1, 0, 0, 10, 0)).toBe(false);
  });

  it("returns false when another player's circle overlaps the target cell", () => {
    const local = me(1, 0.5, 0.5);
    const blocker = me(2, 2.5, 0.5);
    const { world, terrain } = setup(local, [blocker]);
    expect(canPlaceTopBlock(world, terrain, 1, 0, 0, 2, 0)).toBe(false);
  });

  it("allows placement on a cell tangent to a player's circle", () => {
    // A player exactly one PLAYER_RADIUS (0.35) away from the west edge of
    // cell (2, 0) is tangent to that cell. Strict-less overlap means a
    // tangent circle does not block placement.
    const local = me(1, 0.5, 0.5);
    const tangent = me(2, 2.0 - 0.35, 0.5);
    const { world, terrain } = setup(local, [tangent]);
    expect(canPlaceTopBlock(world, terrain, 1, 0, 0, 2, 0)).toBe(true);
  });

  it("works across non-zero chunk coords", () => {
    const local = me(1, CHUNK_SIZE + 0.5, 0.5);
    const world = new World();
    world.applySnapshot([local]);
    const terrain = new Terrain();
    terrain.insert(1, 0, emptyChunk());
    expect(canPlaceTopBlock(world, terrain, 1, 1, 0, 2, 0)).toBe(true);
  });
});
