// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountXpLabel } from "./xp_label.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.useRealTimers();
});

function labelText(): string {
  return document.getElementById("anarchy-xp-label-text")!.textContent ?? "";
}

function floaters(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".anarchy-xp-floater"),
  );
}

describe("mountXpLabel", () => {
  it("starts hidden and reveals on the first update", () => {
    const label = mountXpLabel();
    const root = document.getElementById("anarchy-xp-label");
    expect(root).not.toBeNull();
    expect(root!.classList.contains("hidden")).toBe(true);

    label.update(0);
    expect(root!.classList.contains("hidden")).toBe(false);
    expect(labelText()).toBe("XP: 0");

    label.unmount();
  });

  it("renders the current XP", () => {
    const label = mountXpLabel();
    label.update(42);
    expect(labelText()).toBe("XP: 42");
    label.update(101);
    expect(labelText()).toBe("XP: 101");
    label.unmount();
  });

  it("clamps negative inputs to 0 and floors fractional values", () => {
    const label = mountXpLabel();
    label.update(-5);
    expect(labelText()).toBe("XP: 0");
    label.update(7.9);
    expect(labelText()).toBe("XP: 7");
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

  describe("+N floater", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("emits a floater with the delta as text on each XP gain", () => {
      const label = mountXpLabel();
      label.update(0);
      expect(floaters()).toHaveLength(0);
      label.update(2);
      const fs = floaters();
      expect(fs).toHaveLength(1);
      expect(fs[0]!.textContent).toBe("+2");
      label.unmount();
    });

    it("stacks multiple floaters when several gains land in quick succession", () => {
      const label = mountXpLabel();
      label.update(0);
      label.update(2);
      label.update(6);
      const fs = floaters();
      expect(fs).toHaveLength(2);
      expect(fs.map((f) => f.textContent)).toEqual(["+2", "+4"]);
      label.unmount();
    });

    it("does not emit a floater when XP stays the same or decreases", () => {
      const label = mountXpLabel();
      label.update(10);
      label.update(10);
      label.update(3);
      expect(floaters()).toHaveLength(0);
      label.unmount();
    });

    it("does not emit a floater on the first non-null update (no prior baseline)", () => {
      const label = mountXpLabel();
      label.update(42);
      expect(floaters()).toHaveLength(0);
      label.unmount();
    });

    it("does not emit a floater after a null reset followed by a non-null value", () => {
      const label = mountXpLabel();
      label.update(10);
      label.update(null);
      label.update(20);
      expect(floaters()).toHaveLength(0);
      label.unmount();
    });

    it("removes each floater after the fade-out duration elapses", () => {
      const label = mountXpLabel();
      label.update(0);
      label.update(5);
      expect(floaters()).toHaveLength(1);
      vi.advanceTimersByTime(599);
      expect(floaters()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(floaters()).toHaveLength(0);
      label.unmount();
    });

    it("applies the flown end-state class on the next macrotask to trigger the transition", () => {
      const label = mountXpLabel();
      label.update(0);
      label.update(3);
      const f = floaters()[0]!;
      expect(f.classList.contains("anarchy-xp-floater--flown")).toBe(false);
      vi.advanceTimersByTime(0);
      expect(f.classList.contains("anarchy-xp-floater--flown")).toBe(true);
      label.unmount();
    });
  });
});
