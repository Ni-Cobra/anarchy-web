// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import { showLobby } from "./lobby.js";

describe("lobby form (ADR 0007)", () => {
  afterEach(() => {
    document.getElementById("anarchy-lobby")?.remove();
  });

  function panel(): HTMLElement {
    const el = document.getElementById("anarchy-lobby");
    if (!el) throw new Error("lobby DOM not mounted");
    return el;
  }

  it("starts in 'New player' mode by default with the color picker visible and no password field", () => {
    showLobby();
    const root = panel();
    const tabNew = root.querySelector<HTMLButtonElement>("#anarchy-tab-new")!;
    const tabReturning = root.querySelector<HTMLButtonElement>(
      "#anarchy-tab-returning",
    )!;
    expect(tabNew.classList.contains("active")).toBe(true);
    expect(tabReturning.classList.contains("active")).toBe(false);
    const colorSection = root.querySelector<HTMLElement>(
      "#anarchy-color-section",
    )!;
    const passwordSection = root.querySelector<HTMLElement>(
      "#anarchy-password-section",
    )!;
    expect(colorSection.style.display).not.toBe("none");
    expect(passwordSection.style.display).toBe("none");
  });

  it("clicking 'Returning player' shows the password field and hides the color picker", () => {
    showLobby();
    const root = panel();
    const tabReturning = root.querySelector<HTMLButtonElement>(
      "#anarchy-tab-returning",
    )!;
    tabReturning.click();
    const colorSection = root.querySelector<HTMLElement>(
      "#anarchy-color-section",
    )!;
    const passwordSection = root.querySelector<HTMLElement>(
      "#anarchy-password-section",
    )!;
    expect(colorSection.style.display).toBe("none");
    expect(passwordSection.style.display).not.toBe("none");
  });

  it("New mode submit produces an identity with empty password and reconnect=false", async () => {
    const promise = showLobby();
    const root = panel();
    const username = root.querySelector<HTMLInputElement>("#anarchy-username")!;
    username.value = "Alice";
    username.dispatchEvent(new Event("input"));
    const submit = root.querySelector<HTMLButtonElement>("#anarchy-submit")!;
    expect(submit.disabled).toBe(false);
    submit.click();
    const identity = await promise;
    expect(identity.username).toBe("Alice");
    expect(identity.reconnect).toBe(false);
    expect(identity.password ?? "").toBe("");
  });

  it("Returning mode submit produces an identity with the typed password and reconnect=true", async () => {
    const promise = showLobby({ mode: "returning" });
    const root = panel();
    const username = root.querySelector<HTMLInputElement>("#anarchy-username")!;
    username.value = "Bob";
    username.dispatchEvent(new Event("input"));
    const password = root.querySelector<HTMLInputElement>("#anarchy-password")!;
    password.value = "hunter2";
    const submit = root.querySelector<HTMLButtonElement>("#anarchy-submit")!;
    submit.click();
    const identity = await promise;
    expect(identity.username).toBe("Bob");
    expect(identity.reconnect).toBe(true);
    expect(identity.password).toBe("hunter2");
  });

  it("renders the rejectMessage when defaults supply one", () => {
    showLobby({ rejectMessage: "Account locked." });
    const root = panel();
    const reject = root.querySelector<HTMLElement>("#anarchy-reject")!;
    expect(reject.classList.contains("visible")).toBe(true);
    expect(reject.textContent).toContain("Account locked.");
  });

  it("submit stays disabled while the username is empty or invalid", () => {
    showLobby();
    const root = panel();
    const submit = root.querySelector<HTMLButtonElement>("#anarchy-submit")!;
    expect(submit.disabled).toBe(true);
    const username = root.querySelector<HTMLInputElement>("#anarchy-username")!;
    username.value = "!!!";
    username.dispatchEvent(new Event("input"));
    expect(submit.disabled).toBe(true);
    username.value = "ok";
    username.dispatchEvent(new Event("input"));
    expect(submit.disabled).toBe(false);
  });

  it("switching from Returning to New clears any typed password", () => {
    showLobby({ mode: "returning" });
    const root = panel();
    const password = root.querySelector<HTMLInputElement>("#anarchy-password")!;
    password.value = "secret";
    const tabNew = root.querySelector<HTMLButtonElement>("#anarchy-tab-new")!;
    tabNew.click();
    expect(password.value).toBe("");
  });
});
