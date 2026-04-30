import { describe, expect, it } from "vitest";

import { anarchy } from "../gen/anarchy.js";
import { keyToAction, SCROLL_KEY_CODES } from "./keymap.js";

const { ActionKind } = anarchy.v1;

describe("keyToAction", () => {
  it.each([
    ["KeyW", ActionKind.ACTION_KIND_MOVE_NORTH],
    ["ArrowUp", ActionKind.ACTION_KIND_MOVE_NORTH],
    ["KeyS", ActionKind.ACTION_KIND_MOVE_SOUTH],
    ["ArrowDown", ActionKind.ACTION_KIND_MOVE_SOUTH],
    ["KeyA", ActionKind.ACTION_KIND_MOVE_WEST],
    ["ArrowLeft", ActionKind.ACTION_KIND_MOVE_WEST],
    ["KeyD", ActionKind.ACTION_KIND_MOVE_EAST],
    ["ArrowRight", ActionKind.ACTION_KIND_MOVE_EAST],
  ])("maps %s to the right ActionKind", (code, expected) => {
    expect(keyToAction(code)).toBe(expected);
  });

  it("returns undefined for unbound keys", () => {
    expect(keyToAction("KeyQ")).toBeUndefined();
    expect(keyToAction("Space")).toBeUndefined();
    expect(keyToAction("")).toBeUndefined();
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
