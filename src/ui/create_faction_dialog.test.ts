// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createFactionErrorMessage,
  showCreateFactionDialog,
} from "./create_faction_dialog.js";

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    "#anarchy-create-faction-name",
  )!;
}

function submitBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    "#anarchy-create-faction-submit",
  )!;
}

function cancelBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    "#anarchy-create-faction-cancel",
  )!;
}

function errorEl(): HTMLDivElement {
  return document.querySelector<HTMLDivElement>(
    "#anarchy-create-faction-error",
  )!;
}

function setValue(value: string): void {
  const el = input();
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

describe("createFactionErrorMessage", () => {
  test("renders the empty error message", () => {
    expect(createFactionErrorMessage("empty")).toContain("empty");
  });
  test("renders the too-long error message", () => {
    expect(createFactionErrorMessage("too_long")).toContain("24");
  });
  test("renders the bad-char error message", () => {
    expect(createFactionErrorMessage("bad_char")).toContain("letters");
  });
});

describe("showCreateFactionDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("submit button is disabled before any input", () => {
    const handle = showCreateFactionDialog({ onSubmit: () => {} });
    expect(submitBtn().disabled).toBe(true);
    handle.close();
  });

  test("submit button enables for a well-formed name", () => {
    const handle = showCreateFactionDialog({ onSubmit: () => {} });
    setValue("Alpha");
    expect(submitBtn().disabled).toBe(false);
    expect(errorEl().textContent).toBe("");
    handle.close();
  });

  test("bad charset rejects with the bad-char message", () => {
    const handle = showCreateFactionDialog({ onSubmit: () => {} });
    setValue("foo!");
    expect(submitBtn().disabled).toBe(true);
    expect(errorEl().textContent).toContain("letters");
    handle.close();
  });

  test("submit fires onSubmit with the trimmed name", () => {
    const onSubmit = vi.fn();
    showCreateFactionDialog({ onSubmit });
    setValue("  Alpha  ");
    submitBtn().click();
    expect(onSubmit).toHaveBeenCalledWith("Alpha");
  });

  test("cancel fires onCancel and closes the dialog", () => {
    const onCancel = vi.fn();
    showCreateFactionDialog({ onSubmit: () => {}, onCancel });
    cancelBtn().click();
    expect(onCancel).toHaveBeenCalled();
    expect(document.getElementById("anarchy-create-faction-modal-root")).toBeNull();
  });

  test("Escape fires onCancel and closes the dialog", () => {
    const onCancel = vi.fn();
    showCreateFactionDialog({ onSubmit: () => {}, onCancel });
    document.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Escape" }),
    );
    expect(onCancel).toHaveBeenCalled();
    expect(document.getElementById("anarchy-create-faction-modal-root")).toBeNull();
  });

  test("close() is idempotent", () => {
    const handle = showCreateFactionDialog({ onSubmit: () => {} });
    handle.close();
    handle.close();
    expect(document.getElementById("anarchy-create-faction-modal-root")).toBeNull();
  });
});
