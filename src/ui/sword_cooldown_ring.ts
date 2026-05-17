/**
 * Sword-slot cooldown ring (task 140). Replaces the bottom-right
 * `Cooldown Xs` badge that lived in the now-deleted `attack_cooldown.ts`
 * — the sword equipment slot is the single canonical surface for the
 * post-strike 5 s cooldown.
 *
 * An SVG ring is absolutely positioned over the slot's interior. A
 * full-circle "track" stays visible only while the cooldown is
 * active so the unavailability reads as a depleting arc, not a static
 * decoration. A dimmer overlay greys out the sword icon while the
 * cooldown is running so the slot reads "not usable" at a glance.
 *
 * The handle's `update(nowMs, strikeMs)` contract matches the badge
 * it replaces — the same rAF loop in `bootstrap/session.ts` drives it
 * and the same `null` / pre-strike / past-expiry edge cases hide the
 * ring.
 *
 * Scope is the post-strike 5 s cooldown only. The 0.7 s charge phase
 * already has the shrinking-beam visual; adding a charge indicator on
 * the slot is a follow-up.
 */

const STYLE_ID = "anarchy-sword-cooldown-ring-style";
const ROOT_CLASS = "anarchy-sword-cooldown-ring";

/** Total cooldown window in ms (mirrors server `COOLDOWN_DURATION_SECS`). */
export const ATTACK_COOLDOWN_DURATION_MS = 5000;

const COOLDOWN_COLOR = "#ffb060";
const RING_RADIUS = 13;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const STYLE = `
  .${ROOT_CLASS} {
    position: absolute;
    inset: 0;
    pointer-events: none;
    display: none;
    z-index: 2;
  }
  .${ROOT_CLASS}.active { display: block; }
  .${ROOT_CLASS} .${ROOT_CLASS}-mask {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.45);
  }
  .${ROOT_CLASS} svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
`;

export interface SwordCooldownRingHandle {
  /**
   * Push the latest cooldown sample. `nowMs` is wall-clock,
   * `strikeMs` is the wall-clock of the most recent local strike
   * (or `null` if the local player has not struck this session).
   * The handle reads the delta itself and decides visibility +
   * arc length.
   */
  update(nowMs: number, strikeMs: number | null): void;
  unmount(): void;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/**
 * Compute the SVG `stroke-dashoffset` for a given remaining fraction
 * of the cooldown. At `remainingFrac = 1` the offset is `0` and the
 * full circle is stroked; at `remainingFrac = 0` the offset equals
 * the circumference and no arc is drawn. Exported so the unit test
 * can pin the depletion formula.
 */
export function dashOffsetForRemainingFrac(remainingFrac: number): number {
  const clamped = remainingFrac < 0 ? 0 : remainingFrac > 1 ? 1 : remainingFrac;
  return RING_CIRCUMFERENCE * (1 - clamped);
}

export function mountSwordCooldownRing(
  slotEl: HTMLElement,
): SwordCooldownRingHandle {
  injectStyle();

  const root = document.createElement("div");
  root.className = ROOT_CLASS;
  root.setAttribute("aria-hidden", "true");

  const mask = document.createElement("div");
  mask.className = `${ROOT_CLASS}-mask`;
  root.appendChild(mask);

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");

  const track = document.createElementNS(svgNs, "circle");
  track.setAttribute("cx", "16");
  track.setAttribute("cy", "16");
  track.setAttribute("r", `${RING_RADIUS}`);
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "rgba(255, 255, 255, 0.25)");
  track.setAttribute("stroke-width", "2.5");
  svg.appendChild(track);

  const arc = document.createElementNS(svgNs, "circle");
  arc.setAttribute("cx", "16");
  arc.setAttribute("cy", "16");
  arc.setAttribute("r", `${RING_RADIUS}`);
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", COOLDOWN_COLOR);
  arc.setAttribute("stroke-width", "2.5");
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", `${RING_CIRCUMFERENCE}`);
  arc.setAttribute("stroke-dashoffset", `${RING_CIRCUMFERENCE}`);
  arc.setAttribute("transform", "rotate(-90 16 16)");
  svg.appendChild(arc);

  root.appendChild(svg);
  slotEl.appendChild(root);

  let visible = false;
  let lastOffset = -1;

  const setVisible = (next: boolean): void => {
    if (visible === next) return;
    visible = next;
    root.classList.toggle("active", next);
  };

  return {
    update: (nowMs, strikeMs) => {
      if (strikeMs === null) {
        setVisible(false);
        return;
      }
      const elapsed = nowMs - strikeMs;
      if (elapsed < 0 || elapsed >= ATTACK_COOLDOWN_DURATION_MS) {
        setVisible(false);
        return;
      }
      const remaining = ATTACK_COOLDOWN_DURATION_MS - elapsed;
      const frac = remaining / ATTACK_COOLDOWN_DURATION_MS;
      const offset = dashOffsetForRemainingFrac(frac);
      if (offset !== lastOffset) {
        arc.setAttribute("stroke-dashoffset", `${offset}`);
        lastOffset = offset;
      }
      setVisible(true);
    },
    unmount: () => {
      root.remove();
    },
  };
}
