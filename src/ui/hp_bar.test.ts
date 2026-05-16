// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { MAX_PLAYER_HEALTH } from "../game/player.js";
import {
  hpFillColorFor,
  hpFillWidthPx,
  HP_THRESHOLD_HIGH,
  HP_THRESHOLD_LOW,
  mountHpBar,
} from "./hp_bar.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("hpFillColorFor", () => {
  it("greens above the high threshold", () => {
    expect(hpFillColorFor(0.61)).toBe(hpFillColorFor(1.0));
    expect(hpFillColorFor(HP_THRESHOLD_HIGH + 0.0001)).not.toBe(
      hpFillColorFor(HP_THRESHOLD_HIGH),
    );
  });

  it("yellows between the low and high thresholds (inclusive at low)", () => {
    const mid = hpFillColorFor((HP_THRESHOLD_HIGH + HP_THRESHOLD_LOW) / 2);
    expect(mid).toBe(hpFillColorFor(HP_THRESHOLD_LOW));
    expect(mid).toBe(hpFillColorFor(HP_THRESHOLD_HIGH));
  });

  it("reds below the low threshold", () => {
    const red = hpFillColorFor(HP_THRESHOLD_LOW - 0.0001);
    expect(red).toBe(hpFillColorFor(0));
    expect(red).not.toBe(hpFillColorFor(HP_THRESHOLD_LOW));
  });
});

describe("hpFillWidthPx", () => {
  it("scales the fill width by the HP fraction", () => {
    expect(hpFillWidthPx(50, 100, 200)).toBe(100);
    expect(hpFillWidthPx(0, 100, 200)).toBe(0);
    expect(hpFillWidthPx(100, 100, 200)).toBe(200);
  });

  it("clamps to [0, width]", () => {
    expect(hpFillWidthPx(-5, 100, 200)).toBe(0);
    expect(hpFillWidthPx(999, 100, 200)).toBe(200);
  });

  it("returns 0 for non-positive max", () => {
    expect(hpFillWidthPx(50, 0, 200)).toBe(0);
  });
});

describe("mountHpBar", () => {
  it("starts hidden and reveals on the first update", () => {
    const bar = mountHpBar();
    const root = document.getElementById("anarchy-hp-bar");
    expect(root).not.toBeNull();
    expect(root!.classList.contains("hidden")).toBe(true);

    bar.update(80);
    expect(root!.classList.contains("hidden")).toBe(false);
    const text = root!.querySelector(".anarchy-hp-text")!;
    expect(text.textContent).toBe(`80 / ${MAX_PLAYER_HEALTH}`);

    bar.unmount();
  });

  it("paints the fill width proportionally to HP / MAX", () => {
    const bar = mountHpBar();
    bar.update(50);
    const fill = document.querySelector(
      "#anarchy-hp-bar .anarchy-hp-fill",
    ) as HTMLElement;
    // The bar width is fixed at 476 px (matches the hotbar). 50/100 → 238 px.
    expect(fill.style.width).toBe("238px");
    bar.unmount();
  });

  it("hides again when update(null) is passed", () => {
    const bar = mountHpBar();
    bar.update(70);
    const root = document.getElementById("anarchy-hp-bar")!;
    expect(root.classList.contains("hidden")).toBe(false);
    bar.update(null);
    expect(root.classList.contains("hidden")).toBe(true);
    bar.unmount();
  });

  it("clamps a stale wire MAX value into the bar", () => {
    const bar = mountHpBar();
    bar.update(999_999);
    const text = document.querySelector(
      "#anarchy-hp-bar .anarchy-hp-text",
    )!;
    expect(text.textContent).toBe(`${MAX_PLAYER_HEALTH} / ${MAX_PLAYER_HEALTH}`);
    bar.unmount();
  });

  it("unmount removes the DOM root", () => {
    const bar = mountHpBar();
    expect(document.getElementById("anarchy-hp-bar")).not.toBeNull();
    bar.unmount();
    expect(document.getElementById("anarchy-hp-bar")).toBeNull();
  });
});
