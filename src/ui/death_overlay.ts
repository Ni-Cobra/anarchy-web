/**
 * Respawn "You died" overlay — task 160.
 *
 * On local-player death the bootstrap controller calls `trigger(nowMs)`;
 * the overlay paints the screen fully black with a large red "You died"
 * title, then fades both elements over independent timelines:
 *
 *   - Black layer  : opacity 1 → 0 over 4.0 s
 *   - Title text   : opacity 1 → 0 over 8.0 s
 *
 * Both fades are JS-driven via `tick(nowMs)` from the existing per-frame
 * rAF loop in `session.ts` — no CSS transitions, because the trigger needs
 * to set `opacity = 1` synchronously to hide the same-tick respawn
 * teleport. A re-trigger restarts the timeline; `cancel()` hides the
 * overlay without running the fade (used on local-player id reassign
 * after a reconnect).
 *
 * Network-free; the wire bridge fans `WireDeathEvent`s into a small
 * controller that calls `trigger` when the event's `playerId` matches
 * the local id.
 */

const STYLE_ID = "anarchy-death-overlay-style";
const ROOT_ID = "anarchy-death-overlay";

/** Black overlay fade duration (seconds). */
export const BLACK_FADE_SECONDS = 4.0;
/** Title text fade duration (seconds). */
export const TITLE_FADE_SECONDS = 8.0;

const STYLE = `
  #${ROOT_ID} {
    position: fixed;
    inset: 0;
    z-index: 9990;
    pointer-events: none;
    display: none;
    background: #000000;
    font-family: system-ui, -apple-system, sans-serif;
  }
  #${ROOT_ID}.visible { display: block; }
  #${ROOT_ID} .anarchy-death-title {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 96px;
    font-weight: 800;
    color: #ff3030;
    letter-spacing: 4px;
    text-shadow:
      0 4px 16px rgba(0, 0, 0, 0.95),
      0 0 32px rgba(255, 48, 48, 0.45);
    user-select: none;
    white-space: nowrap;
  }
`;

export interface DeathOverlayState {
  visible: boolean;
  blackOpacity: number;
  titleOpacity: number;
}

export interface DeathOverlayHandle {
  /**
   * Fire the death animation. Sets both elements to opacity 1
   * synchronously (no CSS transition), pins `triggerMs`, and the next
   * `tick` calls advance the fades. A re-trigger restarts the timeline.
   */
  trigger(nowMs: number): void;
  /**
   * Per-frame update — recomputes opacities from `(nowMs - triggerMs)`.
   * No-op when the overlay isn't active. Hides + resets state once
   * both timelines complete.
   */
  tick(nowMs: number): void;
  /**
   * Hide + reset without animating. Used on local-player id reassign
   * (rare — reconnect with a different id) so a stale overlay from the
   * previous life doesn't bleed into the new session.
   */
  cancel(): void;
  /** Read the current visual state — exposed for tests + e2e probes. */
  state(): DeathOverlayState;
  unmount(): void;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export function mountDeathOverlay(): DeathOverlayHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const title = document.createElement("div");
  title.className = "anarchy-death-title";
  title.textContent = "You died";
  title.setAttribute("role", "status");
  title.setAttribute("aria-live", "assertive");
  root.appendChild(title);

  document.body.appendChild(root);

  let triggerMs: number | null = null;
  let blackOpacity = 0;
  let titleOpacity = 0;

  const applyOpacities = (): void => {
    root.style.opacity = `${blackOpacity}`;
    title.style.opacity = `${titleOpacity}`;
  };

  const hide = (): void => {
    triggerMs = null;
    blackOpacity = 0;
    titleOpacity = 0;
    root.classList.remove("visible");
    applyOpacities();
  };

  return {
    trigger: (nowMs) => {
      triggerMs = nowMs;
      blackOpacity = 1;
      titleOpacity = 1;
      root.classList.add("visible");
      applyOpacities();
    },
    tick: (nowMs) => {
      if (triggerMs === null) return;
      const elapsedSec = Math.max(0, (nowMs - triggerMs) / 1000);
      if (elapsedSec >= TITLE_FADE_SECONDS) {
        hide();
        return;
      }
      blackOpacity =
        elapsedSec >= BLACK_FADE_SECONDS
          ? 0
          : 1 - elapsedSec / BLACK_FADE_SECONDS;
      titleOpacity = 1 - elapsedSec / TITLE_FADE_SECONDS;
      applyOpacities();
    },
    cancel: () => {
      hide();
    },
    state: () => ({
      visible: triggerMs !== null,
      blackOpacity,
      titleOpacity,
    }),
    unmount: () => {
      root.remove();
    },
  };
}
