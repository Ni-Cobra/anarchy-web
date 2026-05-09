/**
 * Tiny in-session toast banner mounted near the bottom of the viewport.
 * Used by the bootstrap layer to surface async results (today: register-
 * account success / failure, ADR 0007).
 *
 * Lazy host: the shared host element is only attached to `document.body`
 * on the first `show` so an empty session pays no DOM cost. `unmount`
 * removes the host (and any in-flight toasts under it) so a Disconnect
 * leaves the page clean.
 */

const HOST_ID = "anarchy-toast-host";

export type ToastKind = "ok" | "error";

export interface ToastHandle {
  show(text: string, kind: ToastKind): void;
  unmount(): void;
}

export function mountToastHost(): ToastHandle {
  let host: HTMLElement | null = null;

  function ensureHost(): HTMLElement {
    if (host !== null) return host;
    const el = document.createElement("div");
    el.id = HOST_ID;
    el.style.cssText =
      "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9700;display:flex;flex-direction:column;gap:8px;align-items:center;font-family:system-ui,-apple-system,sans-serif;";
    document.body.appendChild(el);
    host = el;
    return el;
  }

  return {
    show(text, kind) {
      const h = ensureHost();
      const toast = document.createElement("div");
      toast.textContent = text;
      toast.style.cssText = `padding:10px 16px;border-radius:6px;font-size:13px;color:#fff;background:${
        kind === "ok" ? "#1e7a3a" : "#a32d2d"
      };box-shadow:0 4px 12px rgba(0,0,0,0.4);opacity:0;transition:opacity 0.18s ease;`;
      h.appendChild(toast);
      requestAnimationFrame(() => (toast.style.opacity = "1"));
      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 250);
      }, 3000);
    },
    unmount() {
      if (host !== null) {
        host.remove();
        host = null;
      }
    },
  };
}
