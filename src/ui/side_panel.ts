/**
 * In-game side panel: a corner toggle button that slides open a vertical
 * stack of action buttons. The action set is data-driven via an array of
 * `{ label, onClick }` so callers extend the panel without hand-writing DOM
 * for each new entry.
 *
 * Lives in `src/ui/` — the layer for DOM overlays drawn over the game
 * canvas. Co-locates its own CSS the way `lobby.ts` does so the component
 * is self-contained: a single import + `mountSidePanel(...)` is enough to
 * get a working panel.
 *
 * Click handling: when the panel root is hovered/clicked, `mousedown` is
 * stopped from propagating to `window`. `bootstrap.ts` registers the break/
 * place handlers on `window`, so without this stop a click on a panel
 * button would also fire a destroy/place behind the panel.
 */

const STYLE_ID = "anarchy-side-panel-style";

const STYLE = `
  #anarchy-side-panel-root {
    position: fixed;
    top: 0;
    right: 0;
    height: 100vh;
    pointer-events: none;
    z-index: 9000;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
  }
  #anarchy-side-panel-root > * { pointer-events: auto; }
  .anarchy-side-panel-toggle {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(20, 24, 30, 0.92);
    color: #f0f0f0;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    padding: 0;
  }
  .anarchy-side-panel-toggle:hover { background: rgba(40, 48, 56, 0.95); }
  .anarchy-side-panel {
    position: absolute;
    top: 0;
    right: 0;
    width: 240px;
    height: 100%;
    background: rgba(20, 24, 30, 0.96);
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
    transform: translateX(100%);
    transition: transform 0.18s ease;
    box-sizing: border-box;
    padding: 56px 16px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .anarchy-side-panel.open { transform: translateX(0); }
  .anarchy-side-panel-action {
    width: 100%;
    padding: 10px 12px;
    background: #2a3340;
    color: #f0f0f0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s ease;
  }
  .anarchy-side-panel-action:hover { background: #3a4854; }
  .anarchy-side-panel-close {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: transparent;
    color: #f0f0f0;
    cursor: pointer;
    font-size: 22px;
    line-height: 1;
    padding: 0;
  }
  .anarchy-side-panel-close:hover { background: rgba(255, 255, 255, 0.08); }
`;

/**
 * One entry in the panel's vertical action stack. The panel is a registry
 * — pass a new `SidePanelAction` to add a button; no per-action DOM is
 * hand-written by the caller.
 */
export interface SidePanelAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface SidePanelOptions {
  readonly actions: ReadonlyArray<SidePanelAction>;
}

export interface SidePanelHandle {
  isOpen(): boolean;
  setOpen(open: boolean): void;
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
 * Mount the side panel into `document.body` and return a handle. The panel
 * starts collapsed; only the toggle button is visible until clicked. Esc
 * closes the panel when open. Call `unmount()` to remove all DOM and
 * listeners — used by `runMain`'s `stop()` so a Disconnect leaves nothing
 * behind.
 */
export function mountSidePanel(options: SidePanelOptions): SidePanelHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = "anarchy-side-panel-root";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "anarchy-side-panel-toggle";
  toggle.setAttribute("aria-label", "Open side panel");
  toggle.textContent = "☰";
  root.appendChild(toggle);

  const panel = document.createElement("aside");
  panel.className = "anarchy-side-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Game side panel");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "anarchy-side-panel-close";
  close.setAttribute("aria-label", "Close side panel");
  close.textContent = "×";
  panel.appendChild(close);

  for (const action of options.actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "anarchy-side-panel-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => action.onClick());
    panel.appendChild(btn);
  }

  root.appendChild(panel);

  let open = false;
  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    panel.classList.toggle("open", open);
    toggle.style.display = open ? "none" : "";
  };

  toggle.addEventListener("click", () => setOpen(true));
  close.addEventListener("click", () => setOpen(false));

  // Stop pointer events from reaching `window` so the bootstrap-level
  // mousedown / contextmenu handlers don't fire destroy/place when a click
  // lands on the panel or the toggle button.
  for (const ev of ["mousedown", "mouseup", "click", "contextmenu"] as const) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }

  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.code === "Escape" && open) {
      setOpen(false);
    }
  };
  window.addEventListener("keydown", onKeydown);

  document.body.appendChild(root);

  return {
    isOpen: () => open,
    setOpen,
    unmount: () => {
      window.removeEventListener("keydown", onKeydown);
      root.remove();
    },
  };
}
