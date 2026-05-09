/**
 * Window-level key + wheel bindings driven from `bootstrap`.
 *
 * Listeners installed:
 * - `keydown` for `E` (toggle inventory), `M` (zoom-out toggle),
 *   `+` / `=` / `-` (continuous zoom), `Digit1..9` (hotbar select).
 * - `wheel` for hotbar cycling and `Ctrl+Wheel` zoom (non-passive so the
 *   browser's page-zoom shortcut can be suppressed when the modifier is
 *   held).
 *
 * Owned local state is the toggled `zoomedOut` flag — the renderer holds
 * the actual camera mode; this module just remembers what to flip to next.
 */

import { HOTBAR_SLOTS } from "../game/index.js";
import { type Renderer } from "../render/index.js";
import { type InventoryUiHandle } from "../ui/index.js";

export interface KeybindingDeps {
  readonly inventoryUi: InventoryUiHandle;
  readonly renderer: Renderer;
}

/**
 * Install the keydown + wheel listeners on `target`. Returns a `detach`
 * callback that removes both, suitable for pushing into the `bootstrap`
 * teardown stack.
 */
export function attachKeybindings(
  target: Window,
  deps: KeybindingDeps,
): () => void {
  let zoomedOut = false;

  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    if (ev.code === "KeyE") {
      deps.inventoryUi.toggle();
      return;
    }
    // Escape closes the inventory side panel + crafting panel together —
    // matches the task-100 spec ("inventory closes (E or Escape)"). The
    // dragdrop module already owns Escape during an active drag (capture
    // listener that returns early when no drag is in flight), so this
    // bubble-phase branch only fires when no drag gesture is pending.
    if (ev.code === "Escape" && deps.inventoryUi.isOpen()) {
      deps.inventoryUi.setOpen(false);
      return;
    }
    if (ev.code === "KeyM") {
      zoomedOut = !zoomedOut;
      deps.renderer.setZoomedOut(zoomedOut);
      return;
    }
    // `+` / `-` continuous zoom. We accept `Equal` (the unshifted `=`/`+`
    // key on US layouts) and `Minus`, plus their numpad twins, so users
    // don't have to hold Shift to nudge zoom. Ctrl+Wheel below covers the
    // mouse / trackpad path. Plain mouse wheel keeps cycling the hotbar.
    if (ev.code === "Equal" || ev.code === "NumpadAdd") {
      deps.renderer.nudgeZoom(1);
      return;
    }
    if (ev.code === "Minus" || ev.code === "NumpadSubtract") {
      deps.renderer.nudgeZoom(-1);
      return;
    }
    // Digits 1..9 select hotbar slots 0..8. `event.code` keeps the binding
    // robust to keyboard layouts where the produced character differs.
    if (ev.code.startsWith("Digit")) {
      const digit = Number(ev.code.slice("Digit".length));
      if (digit >= 1 && digit <= HOTBAR_SLOTS) {
        deps.inventoryUi.selectHotbarSlot(digit - 1);
        return;
      }
    }
  };
  target.addEventListener("keydown", onKeydown);

  // Mouse wheel cycles hotbar selection ±1 with wraparound. Up = previous.
  // `Ctrl+Wheel` is intercepted as a zoom step instead — gives trackpad
  // users a pinch-equivalent without fighting the hotbar binding. We
  // can't be passive on this listener anymore because Ctrl+Wheel needs
  // `preventDefault` to suppress the browser's page-zoom shortcut.
  const onWheel = (ev: WheelEvent): void => {
    if (ev.deltaY === 0) return;
    if (ev.ctrlKey) {
      ev.preventDefault();
      deps.renderer.nudgeZoom(ev.deltaY > 0 ? -1 : 1);
      return;
    }
    const cur = deps.inventoryUi.selectedHotbarSlot();
    const step = ev.deltaY > 0 ? 1 : -1;
    const next = (cur + step + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    deps.inventoryUi.selectHotbarSlot(next);
  };
  target.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    target.removeEventListener("keydown", onKeydown);
    target.removeEventListener("wheel", onWheel);
  };
}
