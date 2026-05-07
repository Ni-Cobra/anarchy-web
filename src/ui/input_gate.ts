/**
 * "This DOM subtree owns input while it's mounted." Helper that stops
 * keyboard / mouse / wheel / pointer events targeted at the gated subtree
 * from reaching the bootstrap-level `window` listeners — the player
 * shouldn't drive movement / hotbar / destroy / place / context menu while
 * typing into a modal's input or clicking on its panel.
 *
 * Implementation: bubble-phase listeners attached at `document`. The event
 * propagates target → ancestors → document. When the document sees an
 * event whose target is inside `root`, the gate calls `stopPropagation()`
 * so the event never bubbles up to the `window`-level handlers the
 * bootstrap registers (movement keys live one layer deeper in
 * `InputController` but are also bound to the same `window`; hotbar
 * digits, `KeyE`, `KeyM`, mousedown destroy/place, `contextmenu`
 * suppression, wheel hotbar cycle are all on `window`). Events whose
 * target is OUTSIDE `root` pass through untouched — clicking the world
 * while a modal is open keeps interacting with the game.
 *
 * Why bubble (not capture): a capture-phase document listener that calls
 * `stopPropagation()` aborts dispatch *before* the target phase, which
 * would also kill the modal's own target-phase listeners (button clicks,
 * input keydown handlers for Enter-to-submit). Bubble fires after target,
 * so target listeners inside the gated subtree run untouched; the gate
 * only blocks the subsequent walk back up to `window`. The bootstrap
 * registers its input listeners on `window` in default (bubble) phase, so
 * a `document`-bubble stop is sufficient to keep them dormant. (This is a
 * different choice from `inventory.ts`'s escape-cancels-drag listener,
 * which uses document-capture but does NOT call `stopPropagation` — it
 * only observes.)
 *
 * Not for the inventory: the inventory hotbar / panel must NOT eat
 * keyboard input — digit hotbar selection, `KeyE` toggle, and movement
 * keys all keep working while the panel is visible. The inventory keeps
 * a bespoke pointer-event-only stop on its own roots; do not retrofit
 * this helper there.
 */

const GATED_EVENTS = [
  "keydown",
  "keyup",
  "keypress",
  "mousedown",
  "mouseup",
  "click",
  "contextmenu",
  "wheel",
  "pointerdown",
  "pointerup",
] as const;

export interface InputGateHandle {
  /** Remove every listener the gate added. Idempotent. */
  detach(): void;
}

/**
 * Attach an input gate to `root`. While attached, events whose target is
 * inside `root` (including `root` itself) do not bubble to `window`-level
 * listeners.
 */
export function attachInputGate(root: HTMLElement): InputGateHandle {
  const handler = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (!root.contains(target)) return;
    e.stopPropagation();
  };
  for (const ev of GATED_EVENTS) {
    document.addEventListener(ev, handler);
  }
  let detached = false;
  return {
    detach: (): void => {
      if (detached) return;
      detached = true;
      for (const ev of GATED_EVENTS) {
        document.removeEventListener(ev, handler);
      }
    },
  };
}
