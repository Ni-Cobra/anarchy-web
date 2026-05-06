/**
 * In-game account-registration modal (ADR 0007). Triggered from the side
 * panel; collects password + confirmation, validates locally (min length,
 * fields match), and resolves with the typed password so the caller can
 * ship a `RegisterAccount` frame. Closes on submit, cancel, or Esc.
 *
 * Self-contained DOM + CSS injection like the rest of `src/ui/`. The
 * caller is responsible for sending the wire frame and surfacing the
 * server's `RegisterAccountResult` via a separate notification — this
 * module does not touch the network.
 */

const STYLE_ID = "anarchy-register-modal-style";

/** Min password length, mirrors the server's defense-in-depth check. */
export const MIN_PASSWORD_LEN = 6;

const STYLE = `
  #anarchy-register-modal-root {
    position: fixed;
    inset: 0;
    background: rgba(8, 12, 16, 0.72);
    z-index: 9500;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
  }
  #anarchy-register-modal-root .panel {
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 24px;
    min-width: 320px;
    max-width: 90vw;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  #anarchy-register-modal-root h2 {
    margin: 0 0 12px 0;
    font-size: 17px;
    font-weight: 600;
  }
  #anarchy-register-modal-root .lede {
    font-size: 13px;
    color: #b8c2cc;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  #anarchy-register-modal-root label {
    display: block;
    font-size: 12px;
    color: #b8c2cc;
    margin: 8px 0 6px 0;
  }
  #anarchy-register-modal-root input[type="password"] {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 11px;
    background: #0d1014;
    color: #f0f0f0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    font-size: 14px;
    font-family: inherit;
  }
  #anarchy-register-modal-root input[type="password"]:focus {
    outline: none;
    border-color: #5aa0ff;
  }
  #anarchy-register-modal-root .error {
    color: #ff8080;
    font-size: 12px;
    min-height: 16px;
    margin-top: 6px;
  }
  #anarchy-register-modal-root .row {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  #anarchy-register-modal-root button {
    flex: 1;
    padding: 9px;
    border: none;
    border-radius: 5px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
  }
  #anarchy-register-modal-root .submit {
    background: #4a8fee;
    color: white;
    font-weight: 600;
  }
  #anarchy-register-modal-root .submit:hover { background: #5aa0ff; }
  #anarchy-register-modal-root .submit:disabled {
    background: #3a4854;
    color: #7a8694;
    cursor: not-allowed;
  }
  #anarchy-register-modal-root .cancel {
    background: #2a3340;
    color: #f0f0f0;
  }
  #anarchy-register-modal-root .cancel:hover { background: #3a4854; }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export interface RegisterModalOptions {
  /** Username being registered — shown read-only so the player knows
   * exactly which session identity is being locked. */
  readonly username: string;
  /** Called when the user submits a valid (non-empty, matching, ≥ min
   * length) password. The modal closes immediately on submit. */
  readonly onSubmit: (password: string) => void;
  /** Called if the user cancels or hits Escape. The modal closes. */
  readonly onCancel?: () => void;
}

/**
 * Open the register modal. Returns a handle whose `close()` removes the
 * DOM and listeners — used by the caller's session teardown so a
 * disconnect mid-registration doesn't leave the modal floating.
 */
export interface RegisterModalHandle {
  close(): void;
}

export function showRegisterModal(
  options: RegisterModalOptions,
): RegisterModalHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = "anarchy-register-modal-root";
  root.innerHTML = `
    <div class="panel" role="dialog" aria-label="Register account">
      <h2>Register account</h2>
      <div class="lede">
        Lock the username "<span id="anarchy-register-username"></span>" to a
        password. Future sessions under this name will require it.
      </div>
      <label for="anarchy-register-pw">Password</label>
      <input id="anarchy-register-pw" type="password" autocomplete="new-password"
             placeholder="At least ${MIN_PASSWORD_LEN} characters" />
      <label for="anarchy-register-pw2">Confirm password</label>
      <input id="anarchy-register-pw2" type="password" autocomplete="new-password" />
      <div class="error" id="anarchy-register-error"></div>
      <div class="row">
        <button class="cancel" id="anarchy-register-cancel" type="button">Cancel</button>
        <button class="submit" id="anarchy-register-submit" type="button" disabled>Register</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const usernameSpan = root.querySelector<HTMLSpanElement>(
    "#anarchy-register-username",
  )!;
  usernameSpan.textContent = options.username;
  const pw = root.querySelector<HTMLInputElement>("#anarchy-register-pw")!;
  const pw2 = root.querySelector<HTMLInputElement>("#anarchy-register-pw2")!;
  const submit = root.querySelector<HTMLButtonElement>(
    "#anarchy-register-submit",
  )!;
  const cancel = root.querySelector<HTMLButtonElement>(
    "#anarchy-register-cancel",
  )!;
  const errorEl = root.querySelector<HTMLDivElement>("#anarchy-register-error")!;

  let closed = false;

  function refresh(): void {
    const pwOk = pw.value.length >= MIN_PASSWORD_LEN;
    const matches = pw.value === pw2.value;
    submit.disabled = !(pwOk && matches);
    if (pw.value.length === 0 && pw2.value.length === 0) {
      errorEl.textContent = "";
    } else if (!pwOk) {
      errorEl.textContent = `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
    } else if (!matches) {
      errorEl.textContent = "Passwords don't match.";
    } else {
      errorEl.textContent = "";
    }
  }

  pw.addEventListener("input", refresh);
  pw2.addEventListener("input", refresh);
  pw.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !submit.disabled) submit.click();
  });
  pw2.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !submit.disabled) submit.click();
  });

  // Stop pointer events from reaching the bootstrap-level
  // mousedown/contextmenu handlers so a click inside the modal doesn't
  // trigger destroy/place behind it. Same pattern as the side panel.
  for (const ev of ["mousedown", "mouseup", "click", "contextmenu"] as const) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }

  function close(): void {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKeydown);
    root.remove();
  }

  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.code === "Escape") {
      close();
      options.onCancel?.();
    }
  };
  window.addEventListener("keydown", onKeydown);

  cancel.addEventListener("click", () => {
    close();
    options.onCancel?.();
  });
  submit.addEventListener("click", () => {
    if (submit.disabled) return;
    const value = pw.value;
    close();
    options.onSubmit(value);
  });

  queueMicrotask(() => pw.focus());
  refresh();

  return { close };
}
