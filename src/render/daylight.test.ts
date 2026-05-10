import { describe, it, expect } from "vitest";

import { DAY_LENGTH_SECONDS } from "../config.js";
import {
  DAY_AMBIENT,
  NIGHT_AMBIENT,
  NIGHT_FLOOR_INTENSITY,
  SUN_PEAK_INTENSITY,
  dayPhaseFromSeconds,
  sampleDaylight,
} from "./daylight.js";

const PHASE_NOON = 0.25;
const PHASE_SUNSET = 0.5;
const PHASE_MIDNIGHT = 0.75;

describe("dayPhaseFromSeconds", () => {
  it("wraps positive seconds modulo DAY_LENGTH_SECONDS", () => {
    expect(dayPhaseFromSeconds(0)).toBe(0);
    expect(dayPhaseFromSeconds(DAY_LENGTH_SECONDS)).toBe(0);
    expect(dayPhaseFromSeconds(DAY_LENGTH_SECONDS / 4)).toBeCloseTo(PHASE_NOON);
    expect(dayPhaseFromSeconds(DAY_LENGTH_SECONDS / 2)).toBeCloseTo(PHASE_SUNSET);
    expect(dayPhaseFromSeconds(DAY_LENGTH_SECONDS * 3)).toBeCloseTo(0);
  });

  it("normalises negative seconds back into [0, 1)", () => {
    expect(dayPhaseFromSeconds(-DAY_LENGTH_SECONDS / 4)).toBeCloseTo(PHASE_MIDNIGHT);
    expect(dayPhaseFromSeconds(-DAY_LENGTH_SECONDS)).toBe(0);
  });

  it("collapses non-finite inputs to 0 (sunrise)", () => {
    expect(dayPhaseFromSeconds(Number.NaN)).toBe(0);
    expect(dayPhaseFromSeconds(Infinity)).toBe(0);
    expect(dayPhaseFromSeconds(-Infinity)).toBe(0);
  });
});

describe("sampleDaylight angle / intensity", () => {
  it("at sunrise the sun sits on the +x horizon", () => {
    const s = sampleDaylight(0);
    expect(s.phase).toBe(0);
    expect(s.sunDir.x).toBeCloseTo(1);
    expect(s.sunDir.y).toBeCloseTo(0);
    expect(s.sunDir.z).toBe(0);
  });

  it("at noon the sun is straight up at full intensity", () => {
    const s = sampleDaylight(DAY_LENGTH_SECONDS * PHASE_NOON);
    expect(s.sunDir.x).toBeCloseTo(0);
    expect(s.sunDir.y).toBeCloseTo(1);
    expect(s.sunIntensity).toBeCloseTo(SUN_PEAK_INTENSITY);
    expect(s.ambientIntensity).toBeCloseTo(DAY_AMBIENT);
  });

  it("at sunset the sun returns to the horizon along -x", () => {
    const s = sampleDaylight(DAY_LENGTH_SECONDS * PHASE_SUNSET);
    expect(s.sunDir.x).toBeCloseTo(-1);
    expect(s.sunDir.y).toBeCloseTo(0);
  });

  it("at midnight the sun is below the world and intensity floors", () => {
    const s = sampleDaylight(DAY_LENGTH_SECONDS * PHASE_MIDNIGHT);
    expect(s.sunDir.y).toBeCloseTo(-1);
    expect(s.sunIntensity).toBeCloseTo(NIGHT_FLOOR_INTENSITY);
    expect(s.ambientIntensity).toBeCloseTo(NIGHT_AMBIENT);
  });

  it("nightFactor is 0 from sunrise through sunset and 1 at midnight (task 350)", () => {
    expect(sampleDaylight(0).nightFactor).toBeCloseTo(0);
    expect(sampleDaylight(DAY_LENGTH_SECONDS * PHASE_NOON).nightFactor).toBeCloseTo(0);
    expect(sampleDaylight(DAY_LENGTH_SECONDS * PHASE_SUNSET).nightFactor).toBeCloseTo(0);
    expect(sampleDaylight(DAY_LENGTH_SECONDS * PHASE_MIDNIGHT).nightFactor).toBeCloseTo(1);
    // Halfway from sunset to midnight, sun has dipped below horizon by sin(π/4).
    const between = sampleDaylight(
      DAY_LENGTH_SECONDS * (PHASE_SUNSET + (PHASE_MIDNIGHT - PHASE_SUNSET) / 2),
    );
    expect(between.nightFactor).toBeGreaterThan(0);
    expect(between.nightFactor).toBeLessThan(1);
  });

  it("intensity is monotonic from sunrise up to noon", () => {
    const a = sampleDaylight(DAY_LENGTH_SECONDS * 0.0);
    const b = sampleDaylight(DAY_LENGTH_SECONDS * 0.1);
    const c = sampleDaylight(DAY_LENGTH_SECONDS * 0.2);
    const d = sampleDaylight(DAY_LENGTH_SECONDS * PHASE_NOON);
    expect(a.sunIntensity).toBeLessThan(b.sunIntensity);
    expect(b.sunIntensity).toBeLessThan(c.sunIntensity);
    expect(c.sunIntensity).toBeLessThan(d.sunIntensity);
  });
});
