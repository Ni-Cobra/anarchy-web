/**
 * Pre-game lobby. Shows a username input + palette swatches before the
 * client opens its WebSocket; the chosen identity is shipped as the
 * first `ClientHello` frame and gates server-side admission.
 *
 * Lives at the same DOM-touching layer as `main.ts` and `bootstrap.ts`
 * — keeping the lobby out of `runMain` keeps `bootstrap.ts` free of
 * `document` queries beyond what it already owns. Resolves with the
 * validated `(username, colorIndex, reconnect)` once the user submits;
 * the caller removes the lobby DOM and calls `runMain(identity)`.
 *
 * `setError(message)` is exposed on the resolved handle so the
 * lifecycle owner in `bootstrap.ts` can re-show the lobby with a
 * server-side rejection message ("Username already online" /
 * "No saved character") rendered above the form.
 */

import {
  MAX_USERNAME_LEN,
  PALETTE,
  paletteColorCss,
  validateUsername,
} from "./game/index.js";
import type { LobbyIdentity, LobbyRejectReason } from "./net/index.js";

const STYLE_ID = "anarchy-lobby-style";

const STYLE = `
  #anarchy-lobby {
    position: fixed;
    inset: 0;
    background: radial-gradient(ellipse at center, #25303a, #101418);
    color: #f0f0f0;
    font-family: system-ui, -apple-system, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  #anarchy-lobby .panel {
    background: rgba(20, 24, 30, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 32px 36px;
    min-width: 360px;
    max-width: 90vw;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  #anarchy-lobby h1 {
    margin: 0 0 24px 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.4px;
  }
  #anarchy-lobby label {
    display: block;
    font-size: 13px;
    margin-bottom: 8px;
    color: #b8c2cc;
  }
  #anarchy-lobby input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    background: #0d1014;
    color: #f0f0f0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    font-size: 15px;
    font-family: inherit;
  }
  #anarchy-lobby input[type="text"]:focus {
    outline: none;
    border-color: #5aa0ff;
  }
  #anarchy-lobby .swatches {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin: 12px 0 24px 0;
  }
  #anarchy-lobby .swatch {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 8px;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    transition: transform 0.08s ease;
  }
  #anarchy-lobby .swatch:hover { transform: scale(1.04); }
  #anarchy-lobby .swatch.selected {
    border-color: #ffffff;
    box-shadow: 0 0 0 2px #5aa0ff;
  }
  #anarchy-lobby .submit {
    width: 100%;
    padding: 12px;
    background: #4a8fee;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  #anarchy-lobby .submit:hover { background: #5aa0ff; }
  #anarchy-lobby .submit:disabled {
    background: #3a4854;
    color: #7a8694;
    cursor: not-allowed;
  }
  #anarchy-lobby .error {
    color: #ff8080;
    font-size: 13px;
    min-height: 18px;
    margin-top: 4px;
  }
  #anarchy-lobby .reconnect-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 18px 0;
    color: #b8c2cc;
    font-size: 13px;
  }
  #anarchy-lobby .reconnect-row input {
    width: 16px;
    height: 16px;
    accent-color: #4a8fee;
    cursor: pointer;
  }
  #anarchy-lobby .reject {
    color: #ff8080;
    font-size: 13px;
    margin-bottom: 12px;
    padding: 8px 10px;
    background: rgba(255, 80, 80, 0.08);
    border: 1px solid rgba(255, 80, 80, 0.32);
    border-radius: 6px;
    display: none;
  }
  #anarchy-lobby .reject.visible { display: block; }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/** Initial lobby pre-fill, used by the lifecycle loop to repopulate the
 * form after a `LobbyReject` so the user doesn't lose what they typed. */
export interface LobbyDefaults {
  readonly username?: string;
  readonly colorIndex?: number;
  readonly reconnect?: boolean;
  readonly rejectMessage?: string;
}

/**
 * Render the lobby into `document.body` and resolve with the
 * validated identity once the user submits. The lobby DOM is removed
 * before the promise resolves so the renderer's canvas can take over a
 * clean body. Rejects only if the host page is missing a body — which
 * means a programming error elsewhere.
 */
export function showLobby(defaults: LobbyDefaults = {}): Promise<LobbyIdentity> {
  injectStyle();

  const root = document.createElement("div");
  root.id = "anarchy-lobby";
  const initialReconnect = defaults.reconnect ?? false;
  root.innerHTML = `
    <div class="panel" role="dialog" aria-label="Project Anarchy lobby">
      <h1>Project Anarchy</h1>
      <div class="reject" id="anarchy-reject" role="alert"></div>
      <label for="anarchy-username">Username</label>
      <input id="anarchy-username" type="text" maxlength="${MAX_USERNAME_LEN}"
             autocomplete="off" autocapitalize="off" spellcheck="false"
             placeholder="Enter a name (1-${MAX_USERNAME_LEN} chars)" />
      <div class="error" id="anarchy-error"></div>
      <label style="margin-top:18px;">Color</label>
      <div class="swatches" id="anarchy-swatches"></div>
      <div class="reconnect-row">
        <input id="anarchy-reconnect" type="checkbox" ${initialReconnect ? "checked" : ""} />
        <label for="anarchy-reconnect">Reconnect to existing character</label>
      </div>
      <button class="submit" id="anarchy-submit" type="button" disabled>Enter world</button>
    </div>
  `;
  document.body.appendChild(root);

  const input = root.querySelector<HTMLInputElement>("#anarchy-username")!;
  const submit = root.querySelector<HTMLButtonElement>("#anarchy-submit")!;
  const errorEl = root.querySelector<HTMLDivElement>("#anarchy-error")!;
  const rejectEl = root.querySelector<HTMLDivElement>("#anarchy-reject")!;
  const swatches = root.querySelector<HTMLDivElement>("#anarchy-swatches")!;
  const reconnectInput = root.querySelector<HTMLInputElement>("#anarchy-reconnect")!;

  if (defaults.username !== undefined) input.value = defaults.username;
  if (defaults.rejectMessage) {
    rejectEl.textContent = defaults.rejectMessage;
    rejectEl.classList.add("visible");
  }

  let selectedColor = defaults.colorIndex ?? 0;
  if (selectedColor < 0 || selectedColor >= PALETTE.length) selectedColor = 0;

  for (let i = 0; i < PALETTE.length; i++) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch" + (i === selectedColor ? " selected" : "");
    button.dataset.idx = String(i);
    button.style.background = paletteColorCss(i);
    button.setAttribute("aria-label", PALETTE[i].name);
    button.addEventListener("click", () => {
      selectedColor = i;
      for (const el of swatches.querySelectorAll(".swatch")) {
        el.classList.toggle(
          "selected",
          (el as HTMLElement).dataset.idx === String(i),
        );
      }
    });
    swatches.appendChild(button);
  }

  function refresh(): void {
    const validated = validateUsername(input.value);
    submit.disabled = validated === null;
    if (input.value.length === 0 || validated !== null) {
      errorEl.textContent = "";
    } else {
      errorEl.textContent =
        "1-" +
        MAX_USERNAME_LEN +
        " chars, letters/numbers/space/_/- only";
    }
  }
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !submit.disabled) submit.click();
  });
  // Focus the input after the panel mounts so a player can start typing
  // immediately without clicking. If we're rehydrating from a rejection,
  // place the cursor at the end so editing-on-top is natural.
  queueMicrotask(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  refresh();

  return new Promise<LobbyIdentity>((resolve) => {
    submit.addEventListener("click", () => {
      const username = validateUsername(input.value);
      if (username === null) return;
      root.remove();
      resolve({
        username,
        colorIndex: selectedColor,
        reconnect: reconnectInput.checked,
      });
    });
  });
}

/** Render a human-readable lobby-reject message from a wire reason. */
export function lobbyRejectMessage(reason: LobbyRejectReason): string {
  switch (reason) {
    case "reconnect-live-session":
      return "Username already online — uncheck Reconnect to play with a different name.";
    case "reconnect-no-record":
      return "No saved character for this username.";
  }
}
