import { describe, expect, it } from "vitest";

import { DEFAULT_FACING, Direction8, type Player } from "./player.js";
import { World } from "./world.js";

const p = (
  id: number,
  x = 0,
  y = 0,
  facing: Direction8 = DEFAULT_FACING,
): Player => ({ id, x, y, facing, username: "", colorIndex: 0 });

describe("World", () => {
  it("starts empty", () => {
    const w = new World();
    expect(w.size()).toBe(0);
    expect([...w.players()]).toEqual([]);
    expect(w.getPlayer(1)).toBeUndefined();
  });

  it("applySnapshot ingests every player", () => {
    const w = new World();
    w.applySnapshot([p(1, 2, 3, Direction8.E), p(2, -4, 5, Direction8.N)]);
    expect(w.size()).toBe(2);
    expect(w.getPlayer(1)).toEqual({
      id: 1,
      x: 2,
      y: 3,
      facing: Direction8.E,
      username: "",
      colorIndex: 0,
    });
    expect(w.getPlayer(2)).toEqual({
      id: 2,
      x: -4,
      y: 5,
      facing: Direction8.N,
      username: "",
      colorIndex: 0,
    });
  });

  it("applySnapshot replaces — players absent from the new snapshot are dropped", () => {
    const w = new World();
    w.applySnapshot([p(1), p(2), p(3)]);
    w.applySnapshot([p(2, 7, 7)]);
    expect(w.size()).toBe(1);
    expect(w.getPlayer(1)).toBeUndefined();
    expect(w.getPlayer(2)).toEqual({
      id: 2,
      x: 7,
      y: 7,
      facing: DEFAULT_FACING,
      username: "",
      colorIndex: 0,
    });
    expect(w.getPlayer(3)).toBeUndefined();
  });

  it("applySnapshot copies inputs so external mutation does not leak in", () => {
    const w = new World();
    const input = p(1, 4, 4, Direction8.NE);
    w.applySnapshot([input]);
    input.x = 999;
    input.facing = Direction8.S;
    expect(w.getPlayer(1)).toEqual({
      id: 1,
      x: 4,
      y: 4,
      facing: Direction8.NE,
      username: "",
      colorIndex: 0,
    });
  });

  it("players() yields every current player", () => {
    const w = new World();
    w.applySnapshot([p(3), p(1), p(2)]);
    const ids = [...w.players()].map((pl) => pl.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });
});
