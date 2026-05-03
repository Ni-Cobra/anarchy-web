import { describe, expect, it } from "vitest";

import {
  MAX_USERNAME_LEN,
  PALETTE,
  isValidColorIndex,
  paletteColorCss,
  paletteColorHex,
  validateUsername,
} from "./palette.js";

describe("validateUsername", () => {
  it("trims and accepts simple alphanumeric", () => {
    expect(validateUsername("  alice  ")).toBe("alice");
    expect(validateUsername("Bob_42")).toBe("Bob_42");
    expect(validateUsername("two words")).toBe("two words");
  });

  it("rejects empty after trim", () => {
    expect(validateUsername("")).toBeNull();
    expect(validateUsername("   ")).toBeNull();
  });

  it("rejects too long", () => {
    expect(validateUsername("a".repeat(MAX_USERNAME_LEN + 1))).toBeNull();
  });

  it("rejects bad charset", () => {
    expect(validateUsername("alice!")).toBeNull();
    expect(validateUsername("<script>")).toBeNull();
    expect(validateUsername("café")).toBeNull();
  });
});

describe("isValidColorIndex", () => {
  it("accepts every palette index", () => {
    for (let i = 0; i < PALETTE.length; i++) {
      expect(isValidColorIndex(i)).toBe(true);
    }
  });

  it("rejects out-of-range / non-integer", () => {
    expect(isValidColorIndex(-1)).toBe(false);
    expect(isValidColorIndex(PALETTE.length)).toBe(false);
    expect(isValidColorIndex(1.5)).toBe(false);
    expect(isValidColorIndex(Number.NaN)).toBe(false);
  });
});

describe("palette helpers", () => {
  it("paletteColorHex packs r/g/b into a single 24-bit number", () => {
    const c = PALETTE[0];
    expect(paletteColorHex(0)).toBe((c.r << 16) | (c.g << 8) | c.b);
  });

  it("paletteColorCss renders rgb(...) format", () => {
    const c = PALETTE[2];
    expect(paletteColorCss(2)).toBe(`rgb(${c.r}, ${c.g}, ${c.b})`);
  });
});
