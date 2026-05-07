// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachInputGate } from "./input_gate.js";

describe("attachInputGate", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function makeFixture(): { root: HTMLDivElement; inside: HTMLInputElement; outside: HTMLDivElement } {
    const root = document.createElement("div");
    const inside = document.createElement("input");
    root.appendChild(inside);
    document.body.appendChild(root);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    return { root, inside, outside };
  }

  it("blocks keydown events targeted at the gated subtree from reaching window", () => {
    const { root, inside, outside } = makeFixture();
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);

    const gate = attachInputGate(root);

    inside.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
    expect(onWindow).not.toHaveBeenCalled();

    outside.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
    expect(onWindow).toHaveBeenCalledTimes(1);

    gate.detach();
    window.removeEventListener("keydown", onWindow);
  });

  it("blocks the full bootstrap-relevant event family (mouse / wheel / contextmenu / pointer)", () => {
    const { root, inside } = makeFixture();
    const counts = {
      mousedown: 0,
      mouseup: 0,
      click: 0,
      contextmenu: 0,
      wheel: 0,
      pointerdown: 0,
      pointerup: 0,
      keyup: 0,
    };
    const types = Object.keys(counts) as Array<keyof typeof counts>;
    for (const t of types) {
      window.addEventListener(t, () => {
        counts[t] += 1;
      });
    }

    const gate = attachInputGate(root);

    inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    inside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    inside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    inside.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    inside.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    inside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    inside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    inside.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }));

    for (const t of types) {
      expect(counts[t], `window ${t} should not have fired`).toBe(0);
    }

    gate.detach();
  });

  it("preserves target-phase listeners inside the gate (button click, input keydown)", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    root.appendChild(button);
    const input = document.createElement("input");
    root.appendChild(input);
    document.body.appendChild(root);

    const onButtonClick = vi.fn();
    const onInputKeydown = vi.fn();
    button.addEventListener("click", onButtonClick);
    input.addEventListener("keydown", onInputKeydown);

    const gate = attachInputGate(root);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));

    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(onInputKeydown).toHaveBeenCalledTimes(1);

    gate.detach();
  });

  it("does not block events whose target is outside the gated subtree", () => {
    const { root, outside } = makeFixture();
    const onWindowMousedown = vi.fn();
    window.addEventListener("mousedown", onWindowMousedown);

    const gate = attachInputGate(root);

    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onWindowMousedown).toHaveBeenCalledTimes(1);

    gate.detach();
    window.removeEventListener("mousedown", onWindowMousedown);
  });

  it("detach restores normal propagation", () => {
    const { root, inside } = makeFixture();
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);

    const gate = attachInputGate(root);
    gate.detach();

    inside.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
    expect(onWindow).toHaveBeenCalledTimes(1);

    window.removeEventListener("keydown", onWindow);
  });

  it("detach is idempotent (second call is a no-op, no listeners reattach)", () => {
    const { root, inside } = makeFixture();
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);

    const gate = attachInputGate(root);
    gate.detach();
    gate.detach();

    inside.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
    expect(onWindow).toHaveBeenCalledTimes(1);

    window.removeEventListener("keydown", onWindow);
  });
});
