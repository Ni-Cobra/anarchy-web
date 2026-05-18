/**
 * XP label above the hotbar — task 210.
 *
 * Renders `XP: N` as plain text right-aligned to the hotbar's right edge,
 * sitting in the gap between the hotbar and the HP bar. Drives off the
 * local player's `PlayerSnapshot.xp`; the bootstrap pushes the value via
 * `update`.
 *
 * Network-free; pure DOM. Self-injected CSS. Imperative handle, mounted
 * once at bootstrap time alongside `mountHpBar()`.
 */

const STYLE_ID = "anarchy-xp-label-style";
const ROOT_ID = "anarchy-xp-label";

/**
 * Hotbar width (px) — mirrors `hp_bar.ts::BAR_WIDTH_PX`. Pinned locally so
 * the XP label's right edge tracks the hotbar's right edge without
 * importing layout constants from the HP module.
 */
const HOTBAR_WIDTH_PX = 476;

/**
 * Bottom offset of the label above the hotbar. The HP bar sits at
 * `bottom: 86px`; the XP label perches a few px above it so the right
 * edge of the hotbar carries the XP digit cleanly without overlapping
 * the HP bar's numeric overlay.
 */
const BOTTOM_OFFSET_PX = 104;

const STYLE = `
  #${ROOT_ID} {
    position: fixed;
    left: 50%;
    bottom: ${BOTTOM_OFFSET_PX}px;
    width: ${HOTBAR_WIDTH_PX}px;
    transform: translateX(-50%);
    z-index: 8500;
    pointer-events: none;
    text-align: right;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 600;
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    user-select: none;
  }
  #${ROOT_ID}.hidden { display: none; }
`;

export interface XpLabelHandle {
  /**
   * Push the latest local-player XP. Pass `null` to hide the label
   * (no admitted local player yet).
   */
  update(xp: number | null): void;
  unmount(): void;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export function mountXpLabel(): XpLabelHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.classList.add("hidden");
  root.setAttribute("aria-label", "Player experience");

  document.body.appendChild(root);

  let lastText: string | null = null;

  return {
    update: (xp) => {
      if (xp === null) {
        root.classList.add("hidden");
        return;
      }
      const clamped = Math.max(0, Math.floor(xp));
      const label = `XP: ${clamped}`;
      if (label !== lastText) {
        root.textContent = label;
        lastText = label;
      }
      root.classList.remove("hidden");
    },
    unmount: () => {
      root.remove();
    },
  };
}
