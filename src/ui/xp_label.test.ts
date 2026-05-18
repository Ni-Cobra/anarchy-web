// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountXpLabel } from "./xp_label.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("mountXpLabel", () => {
  it("starts hidden and reveals on the first update", () => {
    const label = mountXpLabel();
    const root = document.getElementById("anarchy-xp-label");
    expect(root).not.toBeNull();
    expect(root!.classList.contains("hidden")).toBe(true);

    label.update(0);
    expect(root!.classList.contains("hidden")).toBe(false);
    expect(root!.textContent).toBe("XP: 0");

    label.unmount();
  });

  it("renders the current XP", () => {
    const label = mountXpLabel();
    label.update(42);
    const root = document.getElementById("anarchy-xp-label")!;
    expect(root.textContent).toBe("XP: 42");
    label.update(101);
    expect(root.textContent).toBe("XP: 101");
    label.unmount();
  });

  it("clamps negative inputs to 0 and floors fractional values", () => {
    const label = mountXpLabel();
    label.update(-5);
    expect(document.getElementById("anarchy-xp-label")!.textContent).toBe(
      "XP: 0",
    );
    label.update(7.9);
    expect(document.getElementById("anarchy-xp-label")!.textContent).toBe(
      "XP: 7",
    );
    label.unmount();
  });

  it("hides when passed null (no admitted local player)", () => {
    const label = mountXpLabel();
    label.update(5);
    const root = document.getElementById("anarchy-xp-label")!;
    expect(root.classList.contains("hidden")).toBe(false);
    label.update(null);
    expect(root.classList.contains("hidden")).toBe(true);
    label.unmount();
  });
});
