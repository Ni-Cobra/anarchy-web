import { describe, expect, it } from "vitest";

import type { Player } from "./player.js";
import { World } from "./world.js";

const p = (id: number, x = 0, y = 0): Player => ({ id, x, y });

describe("World", () => {
  it("starts empty", () => {
    const w = new World();
    expect(w.size()).toBe(0);
    expect([...w.players()]).toEqual([]);
    expect(w.getPlayer(1)).toBeUndefined();
  });

  it("applySnapshot ingests every player", () => {
    const w = new World();
    w.applySnapshot([p(1, 2, 3), p(2, -4, 5)]);
    expect(w.size()).toBe(2);
    expect(w.getPlayer(1)).toEqual({ id: 1, x: 2, y: 3 });
    expect(w.getPlayer(2)).toEqual({ id: 2, x: -4, y: 5 });
  });

  it("applySnapshot replaces — players absent from the new snapshot are dropped", () => {
    const w = new World();
    w.applySnapshot([p(1), p(2), p(3)]);
    w.applySnapshot([p(2, 7, 7)]);
    expect(w.size()).toBe(1);
    expect(w.getPlayer(1)).toBeUndefined();
    expect(w.getPlayer(2)).toEqual({ id: 2, x: 7, y: 7 });
    expect(w.getPlayer(3)).toBeUndefined();
  });

  it("applySnapshot copies inputs so external mutation does not leak in", () => {
    const w = new World();
    const input = p(1, 4, 4);
    w.applySnapshot([input]);
    input.x = 999;
    expect(w.getPlayer(1)).toEqual({ id: 1, x: 4, y: 4 });
  });

  it("removePlayer reports whether the id was present", () => {
    const w = new World();
    w.applySnapshot([p(1), p(2)]);
    expect(w.removePlayer(1)).toBe(true);
    expect(w.removePlayer(1)).toBe(false);
    expect(w.removePlayer(999)).toBe(false);
    expect(w.size()).toBe(1);
    expect(w.getPlayer(2)).toEqual({ id: 2, x: 0, y: 0 });
  });

  it("players() yields every current player", () => {
    const w = new World();
    w.applySnapshot([p(3), p(1), p(2)]);
    const ids = [...w.players()].map((pl) => pl.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });
});
