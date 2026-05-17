// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  ATTACK_COOLDOWN_DURATION_MS,
  dashOffsetForRemainingFrac,
  mountSwordCooldownRing,
} from "./sword_cooldown_ring.js";

const RING_RADIUS = 13;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

function makeSlot(): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "anarchy-equipment-slot anarchy-equipment-slot-sword";
  document.body.appendChild(slot);
  return slot;
}

function readArcOffset(slot: HTMLElement): number {
  const arc = slot.querySelector(
    ".anarchy-sword-cooldown-ring svg circle:nth-of-type(2)",
  ) as SVGCircleElement;
  return Number(arc.getAttribute("stroke-dashoffset"));
}

function readRoot(slot: HTMLElement): HTMLElement {
  return slot.querySelector(".anarchy-sword-cooldown-ring") as HTMLElement;
}

describe("dashOffsetForRemainingFrac", () => {
  it("returns 0 at frac=1 (full arc drawn)", () => {
    expect(dashOffsetForRemainingFrac(1)).toBeCloseTo(0, 6);
  });

  it("returns full circumference at frac=0 (no arc drawn)", () => {
    expect(dashOffsetForRemainingFrac(0)).toBeCloseTo(CIRCUMFERENCE, 6);
  });

  it("returns half circumference at frac=0.5", () => {
    expect(dashOffsetForRemainingFrac(0.5)).toBeCloseTo(CIRCUMFERENCE / 2, 6);
  });

  it("clamps inputs outside [0, 1]", () => {
    expect(dashOffsetForRemainingFrac(-0.5)).toBeCloseTo(CIRCUMFERENCE, 6);
    expect(dashOffsetForRemainingFrac(1.5)).toBeCloseTo(0, 6);
  });
});

describe("mountSwordCooldownRing", () => {
  it("mounts hidden by default — no strikeMs yet", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    const root = readRoot(slot);
    expect(root).not.toBeNull();
    expect(root.classList.contains("active")).toBe(false);
    ring.unmount();
  });

  it("keeps the ring hidden when strikeMs is null", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    ring.update(1000, null);
    expect(readRoot(slot).classList.contains("active")).toBe(false);
    ring.unmount();
  });

  it("shows a near-full arc at the start of the cooldown", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    const now = 1_000_000;
    ring.update(now, now);
    expect(readRoot(slot).classList.contains("active")).toBe(true);
    // remainingFrac == 1 → offset == 0 (full arc).
    expect(readArcOffset(slot)).toBeCloseTo(0, 6);
    ring.unmount();
  });

  it("draws ~half the circumference at the 50% point", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    const now = 1_000_000;
    ring.update(now + ATTACK_COOLDOWN_DURATION_MS / 2, now);
    expect(readArcOffset(slot)).toBeCloseTo(CIRCUMFERENCE / 2, 6);
    ring.unmount();
  });

  it("hides the ring once the cooldown elapses", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    const now = 1_000_000;
    ring.update(now + 100, now);
    expect(readRoot(slot).classList.contains("active")).toBe(true);
    ring.update(now + ATTACK_COOLDOWN_DURATION_MS, now);
    expect(readRoot(slot).classList.contains("active")).toBe(false);
    ring.update(now + ATTACK_COOLDOWN_DURATION_MS + 200, now);
    expect(readRoot(slot).classList.contains("active")).toBe(false);
    ring.unmount();
  });

  it("hides the ring when nowMs is before strikeMs (negative elapsed)", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    const now = 1_000_000;
    ring.update(now - 10, now);
    expect(readRoot(slot).classList.contains("active")).toBe(false);
    ring.unmount();
  });

  it("unmount removes the ring DOM from the slot", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    expect(slot.querySelector(".anarchy-sword-cooldown-ring")).not.toBeNull();
    ring.unmount();
    expect(slot.querySelector(".anarchy-sword-cooldown-ring")).toBeNull();
  });

  it("re-activates on a fresh strike after a previous cooldown completed", () => {
    const slot = makeSlot();
    const ring = mountSwordCooldownRing(slot);
    const now = 1_000_000;
    ring.update(now + 100, now);
    expect(readRoot(slot).classList.contains("active")).toBe(true);
    // First cooldown fully elapses.
    ring.update(now + ATTACK_COOLDOWN_DURATION_MS, now);
    expect(readRoot(slot).classList.contains("active")).toBe(false);
    // Second strike comes in well after the first.
    const strike2 = now + 30_000;
    ring.update(strike2, strike2);
    expect(readRoot(slot).classList.contains("active")).toBe(true);
    expect(readArcOffset(slot)).toBeCloseTo(0, 6);
    ring.unmount();
  });
});
