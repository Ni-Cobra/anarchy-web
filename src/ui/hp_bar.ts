/**
 * HP bar above the hotbar — task 060.
 *
 * Renders a horizontal bar at the same width as the hotbar (so it visually
 * anchors to it), positioned just above. Fill width tracks the local
 * player's HP / max ratio; fill colour bands by HP fraction:
 *   - green at > 60 %
 *   - yellow at 30 % – 60 %
 *   - red at < 30 %
 *
 * Numeric `HP / MAX` overlay sits centred on the bar.
 *
 * Network-free; pure DOM + the local-player health number the bootstrap
 * pushes via `update`. The mount path mirrors `coords_hud.ts` — fixed
 * positioning, self-injected CSS, exported `mountHpBar()` returning an
 * imperative handle.
 */

import { MAX_PLAYER_HEALTH } from "../game/player.js";

const STYLE_ID = "anarchy-hp-bar-style";
const ROOT_ID = "anarchy-hp-bar";

/**
 * Vertical offset above the hotbar (matches the hotbar's `bottom: 16px`
 * + the hotbar's own height (slot + padding ≈ 60px) + a tiny gap). The
 * bar's own height stacks below this so the bottom edge sits ~6px above
 * the top of the hotbar.
 */
const BOTTOM_OFFSET_PX = 86;

/** Bar height in CSS pixels. Small but readable. */
const BAR_HEIGHT_PX = 12;

/**
 * Width of the bar in CSS pixels. Matches the hotbar width
 * (9 slots × 48 + 8 gaps × 4 + 2 × 6 padding = 476 px in task 050's hotbar
 * tuning). Pinned here rather than imported from the inventory style
 * module to keep the HP bar independent of inventory-layout churn — if
 * the hotbar resizes, retune this constant and the visual anchor stays.
 */
const BAR_WIDTH_PX = 476;

/** Visual thresholds — must match the test pins. */
export const HP_THRESHOLD_HIGH = 0.6;
export const HP_THRESHOLD_LOW = 0.3;

const FILL_HIGH = "#3fb950";
const FILL_MID = "#d4a017";
const FILL_LOW = "#d04a4a";

const STYLE = `
  #${ROOT_ID} {
    position: fixed;
    left: 50%;
    bottom: ${BOTTOM_OFFSET_PX}px;
    transform: translateX(-50%);
    width: ${BAR_WIDTH_PX}px;
    height: ${BAR_HEIGHT_PX}px;
    z-index: 8500;
    pointer-events: none;
    background: rgba(20, 24, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    font-family: system-ui, -apple-system, sans-serif;
    user-select: none;
  }
  #${ROOT_ID}.hidden { display: none; }
  #${ROOT_ID} .anarchy-hp-fill {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    transition: width 0.12s ease-out, background-color 0.12s ease-out;
  }
  #${ROOT_ID} .anarchy-hp-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 600;
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    line-height: 1;
  }
`;

export interface HpBarHandle {
  /**
   * Push the latest local-player health. Pass `null` to hide the bar
   * (no admitted local player yet).
   */
  update(health: number | null): void;
  unmount(): void;
}

/**
 * Pick the fill colour for a given HP fraction. Exported so unit tests
 * can pin the threshold behaviour without DOM.
 */
export function hpFillColorFor(fraction: number): string {
  if (fraction > HP_THRESHOLD_HIGH) return FILL_HIGH;
  if (fraction >= HP_THRESHOLD_LOW) return FILL_MID;
  return FILL_LOW;
}

/** Compute the fill width in pixels, clamped to `[0, BAR_WIDTH_PX]`. */
export function hpFillWidthPx(
  health: number,
  max: number = MAX_PLAYER_HEALTH,
  width: number = BAR_WIDTH_PX,
): number {
  if (max <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, health / max));
  return fraction * width;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export function mountHpBar(): HpBarHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.classList.add("hidden");
  root.setAttribute("aria-label", "Player health");

  const fill = document.createElement("div");
  fill.className = "anarchy-hp-fill";
  root.appendChild(fill);

  const text = document.createElement("div");
  text.className = "anarchy-hp-text";
  root.appendChild(text);

  document.body.appendChild(root);

  let lastText: string | null = null;
  let lastColor: string | null = null;
  let lastWidth = -1;

  return {
    update: (health) => {
      if (health === null) {
        root.classList.add("hidden");
        return;
      }
      const clamped = Math.max(0, Math.min(MAX_PLAYER_HEALTH, Math.round(health)));
      const fraction = clamped / MAX_PLAYER_HEALTH;
      const widthPx = fraction * BAR_WIDTH_PX;
      const color = hpFillColorFor(fraction);
      const label = `${clamped} / ${MAX_PLAYER_HEALTH}`;
      if (widthPx !== lastWidth) {
        fill.style.width = `${widthPx}px`;
        lastWidth = widthPx;
      }
      if (color !== lastColor) {
        fill.style.backgroundColor = color;
        lastColor = color;
      }
      if (label !== lastText) {
        text.textContent = label;
        lastText = label;
      }
      root.classList.remove("hidden");
    },
    unmount: () => {
      root.remove();
    },
  };
}
