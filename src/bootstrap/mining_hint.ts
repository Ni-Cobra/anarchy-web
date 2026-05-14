/**
 * Tier-gate mining hint chip mounted near the bottom centre of the
 * viewport. The held-break wiring (`bootstrap/break_place.ts`) drives this
 * on every cursor move to surface why an ore the player is hovering can't
 * be efficiently mined with the currently equipped pickaxe (task 150 +
 * 520).
 *
 * Lazy host: the chip element and its scoped `<style>` are only inserted
 * into the DOM on the first `show` so sessions that never hover a gated
 * cell pay no DOM cost. `show` is idempotent — repeat calls with the same
 * text don't touch `textContent` or `display`, so it tolerates being
 * driven every frame without layout thrash. `unmount` removes the host
 * and the style block so a Disconnect leaves the page clean.
 */

const HOST_ID = "anarchy-mining-hint";
const STYLE_ID = "anarchy-mining-hint-style";

export interface MiningHint {
  show(text: string): void;
  hide(): void;
  unmount(): void;
}

export function createMiningHint(): MiningHint {
  let host: HTMLDivElement | null = null;
  let lastText: string | null = null;
  let visible = false;

  function ensureHost(): HTMLDivElement {
    if (host !== null) return host;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        #${HOST_ID} {
          position: fixed;
          bottom: 96px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 9700;
          padding: 6px 14px;
          background: rgba(20, 24, 30, 0.92);
          border: 1px solid rgba(255, 100, 100, 0.45);
          border-radius: 6px;
          color: #ffb3b3;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 13px;
          line-height: 1.3;
          pointer-events: none;
          display: none;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }
      `;
      document.head.appendChild(style);
    }
    const el = document.createElement("div");
    el.id = HOST_ID;
    document.body.appendChild(el);
    host = el;
    return el;
  }

  return {
    show(text) {
      const el = ensureHost();
      if (lastText !== text) {
        el.textContent = text;
        lastText = text;
      }
      if (!visible) {
        el.style.display = "block";
        visible = true;
      }
    },
    hide() {
      if (host === null) return;
      if (visible) {
        host.style.display = "none";
        visible = false;
      }
      if (lastText !== null) {
        host.textContent = "";
        lastText = null;
      }
    },
    unmount() {
      if (host !== null) {
        host.remove();
        host = null;
      }
      document.getElementById(STYLE_ID)?.remove();
      lastText = null;
      visible = false;
    },
  };
}
