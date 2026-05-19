// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountDeathOverlay } from "./death_overlay.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("mountDeathOverlay", () => {
  it("starts hidden with both timelines at zero", () => {
    const overlay = mountDeathOverlay();
    const state = overlay.state();
    expect(state.visible).toBe(false);
    expect(state.blackOpacity).toBe(0);
    expect(state.titleOpacity).toBe(0);
    const root = document.getElementById("anarchy-death-overlay")!;
    expect(root.classList.contains("visible")).toBe(false);
    overlay.unmount();
  });

  it("trigger paints both layers at full opacity synchronously", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(1_000);
    const state = overlay.state();
    expect(state.visible).toBe(true);
    expect(state.blackOpacity).toBe(1);
    expect(state.titleOpacity).toBe(1);
    const root = document.getElementById("anarchy-death-overlay")!;
    expect(root.classList.contains("visible")).toBe(true);
    expect(root.style.opacity).toBe("1");
    overlay.unmount();
  });

  it("renders the title with the 'You died' string and assertive aria-live", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(0);
    const title = document.querySelector(
      "#anarchy-death-overlay .anarchy-death-title",
    )!;
    expect(title.textContent).toBe("You died");
    expect(title.getAttribute("role")).toBe("status");
    expect(title.getAttribute("aria-live")).toBe("assertive");
    overlay.unmount();
  });

  it("tick advances both timelines at independent rates", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(1_000);
    overlay.tick(3_000);
    let s = overlay.state();
    // 2.0 s elapsed: black = 1 - 2.0/4.0 = 0.5; title = 1 - 2.0/8.0 = 0.75.
    expect(s.blackOpacity).toBeCloseTo(0.5, 5);
    expect(s.titleOpacity).toBeCloseTo(0.75, 5);

    overlay.tick(5_000);
    s = overlay.state();
    // 4.0 s elapsed: black = 0; title = 0.5.
    expect(s.blackOpacity).toBe(0);
    expect(s.titleOpacity).toBeCloseTo(0.5, 5);
    overlay.unmount();
  });

  it("black layer fully transparent at 4 s elapsed", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(0);
    overlay.tick(4_000);
    const s = overlay.state();
    expect(s.visible).toBe(true);
    expect(s.blackOpacity).toBe(0);
    overlay.unmount();
  });

  it("hides + resets once the title timeline completes", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(0);
    overlay.tick(8_000);
    const s = overlay.state();
    expect(s.visible).toBe(false);
    expect(s.blackOpacity).toBe(0);
    expect(s.titleOpacity).toBe(0);
    const root = document.getElementById("anarchy-death-overlay")!;
    expect(root.classList.contains("visible")).toBe(false);
    overlay.unmount();
  });

  it("re-trigger mid-fade resets both timelines to full opacity", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(0);
    overlay.tick(2_000);
    // Half-way through the black fade, three-quarters through the title.
    expect(overlay.state().blackOpacity).toBeCloseTo(0.5, 5);
    overlay.trigger(2_000);
    const s = overlay.state();
    expect(s.blackOpacity).toBe(1);
    expect(s.titleOpacity).toBe(1);
    expect(s.visible).toBe(true);
    overlay.unmount();
  });

  it("tick is a no-op when untriggered", () => {
    const overlay = mountDeathOverlay();
    overlay.tick(5_000);
    const s = overlay.state();
    expect(s.visible).toBe(false);
    expect(s.blackOpacity).toBe(0);
    expect(s.titleOpacity).toBe(0);
    overlay.unmount();
  });

  it("cancel hides the overlay without animation", () => {
    const overlay = mountDeathOverlay();
    overlay.trigger(0);
    expect(overlay.state().visible).toBe(true);
    overlay.cancel();
    const s = overlay.state();
    expect(s.visible).toBe(false);
    expect(s.blackOpacity).toBe(0);
    expect(s.titleOpacity).toBe(0);
    overlay.unmount();
  });

  it("unmount removes the DOM root", () => {
    const overlay = mountDeathOverlay();
    expect(document.getElementById("anarchy-death-overlay")).not.toBeNull();
    overlay.unmount();
    expect(document.getElementById("anarchy-death-overlay")).toBeNull();
  });
});
