/**
 * Per-key contribution to the player's continuous movement intent vector,
 * in world axes (`+x = east`, `+y = north`). Each entry is a unit step in
 * one cardinal direction; the controller sums every held key's vector and
 * normalizes the result so |intent| ≤ 1.
 */
const KEY_TO_DIRECTION: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
};

/**
 * Translate a `KeyboardEvent.code` to its movement-direction contribution
 * `[dx, dy]`, or `undefined` for keys we don't bind. We key off `code`
 * (physical key) rather than `key` (layout-dependent character) so WASD
 * continues to work on AZERTY/Dvorak.
 */
export function keyToDirection(code: string): readonly [number, number] | undefined {
  return KEY_TO_DIRECTION[code];
}

/** Arrow-key codes whose default action (page scroll) we want to suppress. */
export const SCROLL_KEY_CODES: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
