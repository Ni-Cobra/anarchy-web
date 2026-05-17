/**
 * Pre-game lobby form-state machine (ADR 0007). Two-mode form: a "New
 * player" tab collects username + color (anonymous fresh-Hello path), and
 * a "Returning player" tab collects username + password (reconnect-with-
 * optional-password path). The chosen identity is shipped as the first
 * `ClientHello` frame and gates server-side admission.
 *
 * Lives at the same DOM-touching layer as `main.ts` and `bootstrap/` —
 * keeping the lobby out of `runMain` keeps the bootstrap free of
 * `document` queries beyond what it already owns. Resolves with the
 * validated `LobbyIdentity` once the user submits; the caller removes the
 * lobby DOM (we do that here pre-resolve) and calls `runMain(identity)`.
 *
 * The CSS block lives in `lobby_style.ts` and the static DOM scaffold in
 * `lobby_dom.ts`; this module focuses on (a) seeding state from
 * `LobbyDefaults`, (b) the mode tab toggle, (c) live username validation,
 * (d) swatch selection, and (e) submit → resolve. `setError(message)` is
 * surfaced via the `defaults` argument on a follow-up render so the
 * lifecycle owner in `bootstrap/` can re-show the lobby with a server-side
 * rejection message above the form.
 */

import {
  PALETTE,
  paletteColorCss,
  validateUsername,
  MAX_USERNAME_LEN,
} from "./game/index.js";
import type { LobbyIdentity, LobbyRejectReason } from "./net/index.js";
import { mountLobbyDom } from "./lobby_dom.js";
import { injectLobbyStyle } from "./lobby_style.js";

/** Lobby form mode. "new" = fresh-Hello (username + color picker); "returning"
 * = reconnect path (username + password). The reconnect-checkbox flow has
 * been retired (ADR 0007). */
export type LobbyMode = "new" | "returning";

/** Initial lobby pre-fill, used by the lifecycle loop to repopulate the
 * form after a `LobbyReject` so the user doesn't lose what they typed. */
export interface LobbyDefaults {
  readonly mode?: LobbyMode;
  readonly username?: string;
  readonly colorIndex?: number;
  readonly rejectMessage?: string;
}

/**
 * Render the lobby into `document.body` and resolve with the
 * validated identity once the user submits. The lobby DOM is removed
 * before the promise resolves so the renderer's canvas can take over a
 * clean body.
 */
export function showLobby(defaults: LobbyDefaults = {}): Promise<LobbyIdentity> {
  injectLobbyStyle();
  const dom = mountLobbyDom();

  if (defaults.username !== undefined) dom.usernameInput.value = defaults.username;
  if (defaults.rejectMessage) {
    dom.rejectEl.textContent = defaults.rejectMessage;
    dom.rejectEl.classList.add("visible");
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
      for (const el of dom.swatches.querySelectorAll(".swatch")) {
        el.classList.toggle(
          "selected",
          (el as HTMLElement).dataset.idx === String(i),
        );
      }
    });
    dom.swatches.appendChild(button);
  }

  let mode: LobbyMode = defaults.mode ?? "new";

  function applyMode(): void {
    dom.tabNew.classList.toggle("active", mode === "new");
    dom.tabReturning.classList.toggle("active", mode === "returning");
    dom.tabNew.setAttribute("aria-selected", mode === "new" ? "true" : "false");
    dom.tabReturning.setAttribute(
      "aria-selected",
      mode === "returning" ? "true" : "false",
    );
    dom.colorSection.style.display = mode === "new" ? "" : "none";
    dom.passwordSection.style.display = mode === "returning" ? "" : "none";
    if (mode === "new") dom.passwordInput.value = "";
    refresh();
  }

  function refresh(): void {
    const validated = validateUsername(dom.usernameInput.value);
    dom.submit.disabled = validated === null;
    if (dom.usernameInput.value.length === 0 || validated !== null) {
      dom.errorEl.textContent = "";
    } else {
      dom.errorEl.textContent =
        "1-" +
        MAX_USERNAME_LEN +
        " chars, letters/numbers/space/_/- only";
    }
  }

  dom.tabNew.addEventListener("click", () => {
    mode = "new";
    applyMode();
  });
  dom.tabReturning.addEventListener("click", () => {
    mode = "returning";
    applyMode();
  });
  dom.usernameInput.addEventListener("input", refresh);
  dom.usernameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !dom.submit.disabled) dom.submit.click();
  });
  dom.passwordInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !dom.submit.disabled) dom.submit.click();
  });
  applyMode();
  // Focus the input after the panel mounts so a player can start typing
  // immediately without clicking. If we're rehydrating from a rejection,
  // place the cursor at the end so editing-on-top is natural.
  queueMicrotask(() => {
    dom.usernameInput.focus();
    dom.usernameInput.setSelectionRange(
      dom.usernameInput.value.length,
      dom.usernameInput.value.length,
    );
  });

  return new Promise<LobbyIdentity>((resolve) => {
    dom.submit.addEventListener("click", () => {
      const username = validateUsername(dom.usernameInput.value);
      if (username === null) return;
      const password = mode === "returning" ? dom.passwordInput.value : "";
      const reconnect = mode === "returning";
      dom.root.remove();
      resolve({
        username,
        colorIndex: selectedColor,
        reconnect,
        password,
      });
    });
  });
}

/** Render a human-readable lobby-reject message from a wire reason. */
export function lobbyRejectMessage(reason: LobbyRejectReason): string {
  switch (reason) {
    case "reconnect-live-session":
      return "Username already online — wait for the session to end or pick a different name.";
    case "reconnect-no-record":
      return "No saved character for this username.";
    case "password-required":
      return "This username is registered. Enter the password to log in.";
    case "password-incorrect":
      return "Incorrect password for this username.";
    case "username-taken-by-registration":
      return "This username is registered. Switch to Returning player and enter the password.";
    case "server-full":
      return "Server is full. Try again in a moment.";
  }
}
