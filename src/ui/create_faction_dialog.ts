/**
 * Create-faction modal (task 240, ADR 0008 §5).
 *
 * Opens after the local player places a flag the server confirms is
 * un-claimed. Collects a faction name, validates the shape locally
 * (mirror of the server's `validate_faction_name`), and resolves with
 * the trimmed name so the caller can ship a `CreateFactionIntent`. The
 * dialog closes on submit, cancel, or Esc.
 *
 * Self-contained DOM + CSS like the rest of `src/ui/`. The caller is
 * responsible for sending the wire frame and surfacing outcome via the
 * leaderboard delta — the server doesn't ship a typed ack today, so a
 * failed name simply doesn't appear in the next tick's delta.
 *
 * Input handling: the dialog owns input while mounted. `attachInputGate`
 * stops keyboard/mouse events whose target lands inside the modal
 * subtree from reaching the bootstrap-level handlers (matching the
 * register modal's pattern).
 */

import {
  MAX_FACTION_NAME_LEN,
  type FactionNameError,
  validateFactionName,
} from "../game/index.js";

import { attachInputGate } from "./input_gate.js";

const STYLE_ID = "anarchy-create-faction-modal-style";
const ROOT_ID = "anarchy-create-faction-modal-root";

const STYLE = `
  #${ROOT_ID} {
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
  #${ROOT_ID} .panel {
    background: rgba(20, 24, 30, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 24px;
    min-width: 320px;
    max-width: 90vw;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  #${ROOT_ID} h2 {
    margin: 0 0 12px 0;
    font-size: 17px;
    font-weight: 600;
  }
  #${ROOT_ID} .lede {
    font-size: 13px;
    color: #b8c2cc;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  #${ROOT_ID} label {
    display: block;
    font-size: 12px;
    color: #b8c2cc;
    margin: 8px 0 6px 0;
  }
  #${ROOT_ID} input[type="text"] {
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
  #${ROOT_ID} input[type="text"]:focus {
    outline: none;
    border-color: #5aa0ff;
  }
  #${ROOT_ID} .error {
    color: #ff8080;
    font-size: 12px;
    margin: 8px 0 0 0;
    min-height: 14px;
  }
  #${ROOT_ID} .row {
    margin-top: 16px;
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  #${ROOT_ID} button {
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  #${ROOT_ID} .submit {
    background: #4a8fee;
    color: white;
    font-weight: 600;
  }
  #${ROOT_ID} .submit:hover { background: #5aa0ff; }
  #${ROOT_ID} .submit:disabled {
    background: #3a4854;
    color: #7a8694;
    cursor: not-allowed;
  }
  #${ROOT_ID} .cancel {
    background: #2a3340;
    color: #f0f0f0;
  }
  #${ROOT_ID} .cancel:hover { background: #3a4854; }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export interface CreateFactionDialogOptions {
  /** Called when the user submits a name that passes local
   * `validateFactionName`. The dialog closes immediately. */
  readonly onSubmit: (name: string) => void;
  /** Called if the user cancels or hits Escape. The dialog closes. */
  readonly onCancel?: () => void;
}

export interface CreateFactionDialogHandle {
  close(): void;
  /** Test affordance: read the current input value before the user
   * submits. Returns "" if the dialog has been closed. */
  value(): string;
}

/** Map a typed validation error to a user-facing message. */
export function createFactionErrorMessage(reason: FactionNameError): string {
  switch (reason) {
    case "empty":
      return "Name can't be empty.";
    case "too_long":
      return `Name must be at most ${MAX_FACTION_NAME_LEN} characters.`;
    case "bad_char":
      return "Use letters, numbers, spaces, _ or - only.";
  }
}

export function showCreateFactionDialog(
  options: CreateFactionDialogOptions,
): CreateFactionDialogHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="panel" role="dialog" aria-label="Create faction">
      <h2>Create a faction</h2>
      <div class="lede">
        Name the faction bound to this flag. Other players will see it
        on the leaderboard.
      </div>
      <label for="anarchy-create-faction-name">Faction name</label>
      <input id="anarchy-create-faction-name" type="text"
             maxlength="${MAX_FACTION_NAME_LEN}"
             placeholder="e.g. Red Sun, Alpha-1, etc." />
      <div class="error" id="anarchy-create-faction-error"></div>
      <div class="row">
        <button class="cancel" id="anarchy-create-faction-cancel" type="button">Cancel</button>
        <button class="submit" id="anarchy-create-faction-submit" type="button" disabled>Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const nameInput = root.querySelector<HTMLInputElement>(
    "#anarchy-create-faction-name",
  )!;
  const submit = root.querySelector<HTMLButtonElement>(
    "#anarchy-create-faction-submit",
  )!;
  const cancel = root.querySelector<HTMLButtonElement>(
    "#anarchy-create-faction-cancel",
  )!;
  const errorEl = root.querySelector<HTMLDivElement>(
    "#anarchy-create-faction-error",
  )!;

  let closed = false;

  function refresh(): void {
    const raw = nameInput.value;
    if (raw.length === 0) {
      submit.disabled = true;
      errorEl.textContent = "";
      return;
    }
    const res = validateFactionName(raw);
    if (res.ok) {
      submit.disabled = false;
      errorEl.textContent = "";
    } else {
      submit.disabled = true;
      errorEl.textContent = createFactionErrorMessage(res.reason);
    }
  }

  nameInput.addEventListener("input", refresh);
  nameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !submit.disabled) submit.click();
  });

  const gate = attachInputGate(root);

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onEscape, true);
    gate.detach();
    root.remove();
  }

  const onEscape = (ev: KeyboardEvent): void => {
    if (ev.code !== "Escape") return;
    close();
    options.onCancel?.();
  };
  document.addEventListener("keydown", onEscape, true);

  cancel.addEventListener("click", () => {
    close();
    options.onCancel?.();
  });
  submit.addEventListener("click", () => {
    if (submit.disabled) return;
    const res = validateFactionName(nameInput.value);
    if (!res.ok) return;
    close();
    options.onSubmit(res.name);
  });

  queueMicrotask(() => nameInput.focus());
  refresh();

  return {
    close,
    value: () => (closed ? "" : nameInput.value),
  };
}
