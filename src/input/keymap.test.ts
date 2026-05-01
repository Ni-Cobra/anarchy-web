import { describe, expect, it } from "vitest";

import { keyToDirection, SCROLL_KEY_CODES } from "./keymap.js";

describe("keyToDirection", () => {
  it.each([
    ["KeyW", [0, 1]],
    ["ArrowUp", [0, 1]],
    ["KeyS", [0, -1]],
    ["ArrowDown", [0, -1]],
    ["KeyA", [-1, 0]],
    ["ArrowLeft", [-1, 0]],
    ["KeyD", [1, 0]],
    ["ArrowRight", [1, 0]],
  ] as const)("maps %s to the right unit direction vector", (code, expected) => {
    expect(keyToDirection(code)).toEqual(expected);
  });

  it("returns undefined for unbound keys", () => {
    expect(keyToDirection("KeyQ")).toBeUndefined();
    expect(keyToDirection("Space")).toBeUndefined();
    expect(keyToDirection("")).toBeUndefined();
  });

  it("only flags the four arrow keys as scroll-suppressing", () => {
    expect([...SCROLL_KEY_CODES].sort()).toEqual([
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
    ]);
  });
});
