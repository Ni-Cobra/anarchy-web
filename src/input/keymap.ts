import { anarchy } from "../gen/anarchy.js";

const { ActionKind } = anarchy.v1;

const KEY_TO_ACTION: Readonly<Record<string, anarchy.v1.ActionKind>> = {
  KeyW: ActionKind.ACTION_KIND_MOVE_NORTH,
  ArrowUp: ActionKind.ACTION_KIND_MOVE_NORTH,
  KeyS: ActionKind.ACTION_KIND_MOVE_SOUTH,
  ArrowDown: ActionKind.ACTION_KIND_MOVE_SOUTH,
  KeyD: ActionKind.ACTION_KIND_MOVE_EAST,
  ArrowRight: ActionKind.ACTION_KIND_MOVE_EAST,
  KeyA: ActionKind.ACTION_KIND_MOVE_WEST,
  ArrowLeft: ActionKind.ACTION_KIND_MOVE_WEST,
};

/**
 * Translate a `KeyboardEvent.code` to its `ActionKind`, or `undefined` for
 * keys we don't bind. We key off `code` (physical key) rather than `key`
 * (layout-dependent character) so WASD continues to work on AZERTY/Dvorak.
 */
export function keyToAction(code: string): anarchy.v1.ActionKind | undefined {
  return KEY_TO_ACTION[code];
}

/** Arrow-key codes whose default action (page scroll) we want to suppress. */
export const SCROLL_KEY_CODES: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
