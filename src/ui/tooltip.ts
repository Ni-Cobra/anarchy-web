/**
 * Reusable hover-tooltip primitive. A single shared DOM node is created
 * lazily on first attach and reused across every consumer — `attachTooltip`
 * just wires pointer listeners onto the target and swaps the shared node's
 * text + position when the cursor lingers long enough to surface it.
 *
 * The shared node has `pointer-events: none` so it never eats clicks meant
 * for the cell underneath; this matters in the inventory where slots are
 * draggable and clickable. Show is gated behind `SHOW_DELAY_MS` so a quick
 * sweep across cells doesn't flash text everywhere.
 *
 * `getContent()` is consulted on every show / move so the displayed text
 * tracks the underlying state — if a slot's count changes during a hover,
 * the next move re-reads the thunk and updates the badge. Returning `null`
 * hides the tooltip immediately.
 *
 * Viewport-edge clamping: the tooltip prefers bottom-right of the cursor
 * and is pushed back inside the viewport if it would overflow. Reads the
 * tooltip's own `getBoundingClientRect()` for clamping — happy-dom returns
 * a zero rect, which the clamp handles as a no-op.
 */

const STYLE_ID = "anarchy-tooltip-style";
const TOOLTIP_ID = "anarchy-tooltip";
const SHOW_DELAY_MS = 300;
const CURSOR_OFFSET_PX = 12;
const VIEWPORT_PAD_PX = 4;

const STYLE = `
  #${TOOLTIP_ID} {
    position: fixed;
    pointer-events: none;
    z-index: 9800;
    padding: 4px 8px;
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    color: #f0f0f0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    line-height: 1.3;
    white-space: nowrap;
  }
`;

let sharedNode: HTMLDivElement | null = null;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function ensureSharedNode(): HTMLDivElement {
  if (sharedNode !== null && sharedNode.isConnected) return sharedNode;
  injectStyle();
  const el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.style.display = "none";
  document.body.appendChild(el);
  sharedNode = el;
  return el;
}

function position(node: HTMLElement, cursorX: number, cursorY: number): void {
  const rect = node.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = cursorX + CURSOR_OFFSET_PX;
  let top = cursorY + CURSOR_OFFSET_PX;
  if (left + rect.width > vw - VIEWPORT_PAD_PX) {
    left = vw - rect.width - VIEWPORT_PAD_PX;
  }
  if (top + rect.height > vh - VIEWPORT_PAD_PX) {
    top = vh - rect.height - VIEWPORT_PAD_PX;
  }
  if (left < VIEWPORT_PAD_PX) left = VIEWPORT_PAD_PX;
  if (top < VIEWPORT_PAD_PX) top = VIEWPORT_PAD_PX;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

export interface TooltipHandle {
  /** Remove every listener the helper added. Idempotent. */
  detach(): void;
}

/**
 * Content surfaced by a `getContent` thunk: a single line of plain text,
 * or a caller-built HTMLElement for richer bodies (icons, multi-line
 * layouts — used by the crafting recipe tooltip). `null` keeps the
 * tooltip hidden. Plain-text consumers stay on the string branch so
 * `node.textContent === content` still holds — the existing inventory
 * cell tooltips depend on it.
 */
export type TooltipContent = string | HTMLElement | null;

function applyContent(node: HTMLElement, value: string | HTMLElement): void {
  if (typeof value === "string") {
    node.textContent = value;
  } else {
    node.replaceChildren(value);
  }
}

/**
 * Wire hover handlers on `target` so the shared tooltip node surfaces
 * `getContent()` after `SHOW_DELAY_MS` and tracks the cursor. Returning
 * `null` from `getContent` keeps (or makes) the tooltip hidden — useful
 * for empty inventory cells.
 */
export function attachTooltip(
  target: HTMLElement,
  getContent: () => TooltipContent,
): TooltipHandle {
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let lastX = 0;
  let lastY = 0;
  let visible = false;

  const showNow = (): void => {
    showTimer = null;
    const content = getContent();
    if (content === null) {
      hideNow();
      return;
    }
    const node = ensureSharedNode();
    applyContent(node, content);
    node.style.display = "block";
    visible = true;
    position(node, lastX, lastY);
  };

  const hideNow = (): void => {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (visible && sharedNode !== null) {
      sharedNode.style.display = "none";
    }
    visible = false;
  };

  const onEnter = (ev: PointerEvent): void => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = setTimeout(showNow, SHOW_DELAY_MS);
  };

  const onMove = (ev: PointerEvent): void => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (!visible || sharedNode === null) return;
    const content = getContent();
    if (content === null) {
      hideNow();
      return;
    }
    applyContent(sharedNode, content);
    position(sharedNode, lastX, lastY);
  };

  const onLeave = (): void => {
    hideNow();
  };

  target.addEventListener("pointerenter", onEnter);
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerleave", onLeave);
  target.addEventListener("pointercancel", onLeave);

  return {
    detach: (): void => {
      hideNow();
      target.removeEventListener("pointerenter", onEnter);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerleave", onLeave);
      target.removeEventListener("pointercancel", onLeave);
    },
  };
}

/**
 * Test affordance — drops the cached shared node so a fresh `beforeEach`
 * with a wiped `document.body` gets a clean slate. Production code never
 * needs this; the node sits attached to `document.body` for the lifetime
 * of the page.
 */
export function _resetTooltipForTests(): void {
  sharedNode = null;
}
