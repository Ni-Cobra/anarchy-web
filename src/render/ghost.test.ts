import { describe, expect, it } from "vitest";

import {
  BlockType,
  DEFAULT_FACING,
  ItemId,
  MAX_PLAYER_HEALTH,
  Terrain,
  World,
  emptyChunk,
  setBlock,
  type Slot,
} from "../game/index.js";
import {
  computeGhostState,
  placeableBlockForItem,
  placeableBlockForSlot,
} from "./ghost.js";
import type { PickResult } from "./picker.js";

describe("placeableBlockForItem", () => {
  it("maps each placeable item to its server-side `places_block` value", () => {
    expect(placeableBlockForItem(ItemId.Wood)).toBe(BlockType.Wood);
    expect(placeableBlockForItem(ItemId.Stone)).toBe(BlockType.Stone);
    expect(placeableBlockForItem(ItemId.Gold)).toBe(BlockType.Gold);
    expect(placeableBlockForItem(ItemId.Stick)).toBe(BlockType.Sticks);
  });
});

describe("placeableBlockForSlot", () => {
  it("returns null for an empty slot", () => {
    expect(placeableBlockForSlot(null)).toBeNull();
  });

  it("returns the matching block for a placeable stack", () => {
    const slot: Slot = { item: ItemId.Wood, count: 5 };
    expect(placeableBlockForSlot(slot)).toBe(BlockType.Wood);
  });
});

function setupWorld(playerId: number, x: number, y: number): { world: World; terrain: Terrain } {
  const world = new World();
  world.applySnapshot([
    {
      id: playerId,
      x,
      y,
      facing: DEFAULT_FACING,
      colorIndex: 0,
      username: "tester",
      equippedUtility: null,
      openChests: [],
      health: MAX_PLAYER_HEALTH,
    },
  ]);
  const terrain = new Terrain();
  terrain.insert(0, 0, emptyChunk());
  return { world, terrain };
}

function airPick(lx: number, ly: number): PickResult {
  return {
    chunkCoord: [0, 0],
    localXY: [lx, ly],
    layer: "ground",
    block: { kind: BlockType.Grass },
  };
}

describe("computeGhostState", () => {
  it("returns null when the held slot is empty", () => {
    const { world, terrain } = setupWorld(1, 0.5, 0.5);
    const state = computeGhostState({
      slot: null,
      pick: airPick(2, 0),
      world,
      terrain,
      localPlayerId: 1,
    });
    expect(state).toBeNull();
  });

  it("returns null when the cursor isn't over a loaded chunk", () => {
    const { world, terrain } = setupWorld(1, 0.5, 0.5);
    const state = computeGhostState({
      slot: { item: ItemId.Gold, count: 1 },
      pick: null,
      world,
      terrain,
      localPlayerId: 1,
    });
    expect(state).toBeNull();
  });

  it("returns the cell + kind when held slot is placeable and the target is valid", () => {
    const { world, terrain } = setupWorld(1, 0.5, 0.5);
    const state = computeGhostState({
      slot: { item: ItemId.Gold, count: 1 },
      pick: airPick(2, 0),
      world,
      terrain,
      localPlayerId: 1,
    });
    expect(state).toEqual({ cell: [0, 0, 2, 0], kind: BlockType.Gold });
  });

  it("returns null when the picked cell already has a non-Air top block", () => {
    const { world, terrain } = setupWorld(1, 0.5, 0.5);
    const chunk = terrain.get(0, 0)!;
    setBlock(chunk.top, 2, 0, { kind: BlockType.Wood });
    const state = computeGhostState({
      slot: { item: ItemId.Gold, count: 1 },
      pick: airPick(2, 0),
      world,
      terrain,
      localPlayerId: 1,
    });
    expect(state).toBeNull();
  });

  it("returns null when the cell is out of reach", () => {
    const { world, terrain } = setupWorld(1, 0.5, 0.5);
    // Tile (10, 0) is ~10 units from the player at (0.5, 0.5) — well past
    // REACH_BLOCKS = 4.
    const state = computeGhostState({
      slot: { item: ItemId.Wood, count: 1 },
      pick: airPick(10, 0),
      world,
      terrain,
      localPlayerId: 1,
    });
    expect(state).toBeNull();
  });

  it("returns null when no local player id is set", () => {
    const { world, terrain } = setupWorld(1, 0.5, 0.5);
    const state = computeGhostState({
      slot: { item: ItemId.Wood, count: 1 },
      pick: airPick(2, 0),
      world,
      terrain,
      localPlayerId: null,
    });
    expect(state).toBeNull();
  });
});
