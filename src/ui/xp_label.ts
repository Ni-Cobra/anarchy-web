/**
 * XP label above the hotbar — task 210, with the task 290 `+N` floater
 * polish on top.
 *
 * Renders `XP: N` as plain text right-aligned to the hotbar's right edge,
 * sitting in the gap between the hotbar and the HP bar. Drives off the
 * local player's `PlayerSnapshot.xp`; the bootstrap pushes the value via
 * `update`.
 *
 * When `update` observes a strictly-greater XP than the previous non-null
 * value, a transient `+N` element is spawned just above the label and
 * fades out over `FLOATER_DURATION_MS` so the player sees the gain
 * without comparing the label across frames. Multiple gains in quick
 * succession stack — each gets its own element. XP drops (e.g. PvP
 * transfer on the victim side) intentionally render no floater; the
 * silent label drop is enough feedback.
 *
 * Network-free; pure DOM. Self-injected CSS. Imperative handle, mounted
 * once at bootstrap time alongside `mountHpBar()`.
 */

const STYLE_ID = "anarchy-xp-label-style";
const ROOT_ID = "anarchy-xp-label";
const LABEL_TEXT_ID = "anarchy-xp-label-text";
const FLOATER_CLASS = "anarchy-xp-floater";
const FLOATER_FLOWN_CLASS = "anarchy-xp-floater--flown";
const FLOATER_DURATION_MS = 600;

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
  #${ROOT_ID} .${FLOATER_CLASS} {
    position: absolute;
    right: 0;
    bottom: 100%;
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    opacity: 1;
    transform: translateY(0);
    transition: opacity ${FLOATER_DURATION_MS}ms linear,
                transform ${FLOATER_DURATION_MS}ms ease-out;
  }
  #${ROOT_ID} .${FLOATER_CLASS}.${FLOATER_FLOWN_CLASS} {
    opacity: 0;
    transform: translateY(-12px);
  }
`;

export interface XpLabelHandle {
  /**
   * Push the latest local-player XP. Pass `null` to hide the label
   * (no admitted local player yet). A strictly-greater value than the
   * previous non-null call emits a `+delta` floater.
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

  const labelText = document.createElement("span");
  labelText.id = LABEL_TEXT_ID;
  root.appendChild(labelText);

  document.body.appendChild(root);

  let lastXp: number | null = null;
  let lastText: string | null = null;

  const spawnFloater = (delta: number): void => {
    const f = document.createElement("span");
    f.className = FLOATER_CLASS;
    f.textContent = `+${delta}`;
    root.appendChild(f);
    // Kick the transition on the next macrotask so the initial state
    // (opacity 1, translateY 0) is laid down before the end-state class
    // is added — without the deferral the transition has no start frame.
    window.setTimeout(() => {
      f.classList.add(FLOATER_FLOWN_CLASS);
    }, 0);
    window.setTimeout(() => {
      f.remove();
    }, FLOATER_DURATION_MS);
  };

  return {
    update: (xp) => {
      if (xp === null) {
        root.classList.add("hidden");
        lastXp = null;
        return;
      }
      const clamped = Math.max(0, Math.floor(xp));
      const label = `XP: ${clamped}`;
      if (label !== lastText) {
        labelText.textContent = label;
        lastText = label;
      }
      root.classList.remove("hidden");
      if (lastXp !== null && clamped > lastXp) {
        spawnFloater(clamped - lastXp);
      }
      lastXp = clamped;
    },
    unmount: () => {
      root.remove();
    },
  };
}
