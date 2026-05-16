import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_CHARGE_FAILSAFE_MS,
  LocalAttackChargeTracker,
} from "./local_attack_charge_tracker.js";

const LOCAL_ID = 7;

describe("LocalAttackChargeTracker", () => {
  let now = 0;
  let tracker: LocalAttackChargeTracker;

  beforeEach(() => {
    now = 1_000;
    tracker = new LocalAttackChargeTracker(() => now);
  });

  it("is idle by default", () => {
    expect(tracker.isLocalCharging()).toBe(false);
  });

  it("arms on local charge-started and releases on strike-hit", () => {
    tracker.onAttackEvent(
      { attackerPlayerId: LOCAL_ID, outcome: "charge-started" },
      LOCAL_ID,
    );
    expect(tracker.isLocalCharging()).toBe(true);
    tracker.onAttackEvent(
      { attackerPlayerId: LOCAL_ID, outcome: "strike-hit" },
      LOCAL_ID,
    );
    expect(tracker.isLocalCharging()).toBe(false);
  });

  it("releases on strike-missed too", () => {
    tracker.onAttackEvent(
      { attackerPlayerId: LOCAL_ID, outcome: "charge-started" },
      LOCAL_ID,
    );
    tracker.onAttackEvent(
      { attackerPlayerId: LOCAL_ID, outcome: "strike-missed" },
      LOCAL_ID,
    );
    expect(tracker.isLocalCharging()).toBe(false);
  });

  it("ignores events from other attackers", () => {
    tracker.onAttackEvent(
      { attackerPlayerId: 99, outcome: "charge-started" },
      LOCAL_ID,
    );
    expect(tracker.isLocalCharging()).toBe(false);
    tracker.onAttackEvent(
      { attackerPlayerId: LOCAL_ID, outcome: "charge-started" },
      LOCAL_ID,
    );
    // A remote attacker's resolution must not unlock the local charge.
    tracker.onAttackEvent(
      { attackerPlayerId: 99, outcome: "strike-hit" },
      LOCAL_ID,
    );
    expect(tracker.isLocalCharging()).toBe(true);
  });

  it("ignores all events when no local id is known", () => {
    tracker.onAttackEvent(
      { attackerPlayerId: LOCAL_ID, outcome: "charge-started" },
      null,
    );
    expect(tracker.isLocalCharging()).toBe(false);
  });

  describe("failsafe", () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("unlocks unconditionally after CHARGE_DURATION_SECS + 1.0 s", () => {
      tracker.onAttackEvent(
        { attackerPlayerId: LOCAL_ID, outcome: "charge-started" },
        LOCAL_ID,
      );
      expect(tracker.isLocalCharging()).toBe(true);
      now += LOCAL_CHARGE_FAILSAFE_MS - 1;
      expect(tracker.isLocalCharging()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      now += 1;
      expect(tracker.isLocalCharging()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("reset() drops an active charge and silences the warn", () => {
      tracker.onAttackEvent(
        { attackerPlayerId: LOCAL_ID, outcome: "charge-started" },
        LOCAL_ID,
      );
      tracker.reset();
      now += LOCAL_CHARGE_FAILSAFE_MS;
      expect(tracker.isLocalCharging()).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
