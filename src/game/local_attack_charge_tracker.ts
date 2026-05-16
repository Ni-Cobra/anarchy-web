/**
 * Local-player attack-charge gate (task 110).
 *
 * The server locks an attacker immobile for the 0.7 s `Charging` window
 * (`world::mod.rs::tick` zeroes velocity and skips `Player::step` while the
 * attack state is `Charging`). The client mirrors that gate locally so an
 * outbound `MoveIntent` issued during the charge doesn't ship as a wasted
 * frame the server is just going to ignore — and, in a future where local
 * prediction returns, so a predicted translation doesn't smear into a
 * snap-back when the next snapshot lands.
 *
 * The tracker is fed by the wire layer's `attack_events` fan-out: a
 * `charge-started` for the local player arms the lock; the matching
 * `strike-hit` / `strike-missed` for the same attacker releases it. A
 * failsafe timer unconditionally releases the lock after
 * `CHARGE_DURATION_SECS + 1.0 s` so a dropped resolution packet can never
 * strand the local player frozen — the server resolves every charge at
 * exactly 14 ticks (0.7 s), so any wall-clock past that plus 1 s of margin
 * means we missed the resolution event.
 */

import { CHARGE_DURATION_SECS } from "../config.js";

/**
 * Wall-clock cap on a single charge before the tracker force-releases the
 * lock. `CHARGE_DURATION_SECS + 1.0 s` matches the spec in task 110: the
 * server resolves every admitted charge at exactly `CHARGE_TICKS` (14 at
 * 20 Hz, i.e. 0.7 s); 1 s of margin absorbs network jitter without ever
 * leaving a frozen client behind a packet drop.
 */
export const LOCAL_CHARGE_FAILSAFE_MS =
  CHARGE_DURATION_SECS * 1000 + 1000;

/**
 * Pure-state tracker. Owns no DOM, no network, no renderer. Bootstrap
 * wires the per-tick `attack_events` fan-out into [`onAttackEvent`] and
 * the input gate reads [`isLocalCharging`] each flush.
 */
export class LocalAttackChargeTracker {
  /** Wall-clock ms at which the active charge was observed, or `null`
   *  when the local player is not mid-charge. */
  private chargeStartMs: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Observe one attack event. Only events where `attackerPlayerId ===
   * localPlayerId` move state; everything else is ignored. Idempotent —
   * duplicate `charge-started` events overwrite the timestamp (a server
   * re-ship across reconnect is the realistic case).
   */
  onAttackEvent(
    event: {
      readonly attackerPlayerId: number;
      readonly outcome: "charge-started" | "strike-hit" | "strike-missed";
    },
    localPlayerId: number | null,
  ): void {
    if (localPlayerId === null || event.attackerPlayerId !== localPlayerId) {
      return;
    }
    if (event.outcome === "charge-started") {
      this.chargeStartMs = this.now();
    } else {
      this.chargeStartMs = null;
    }
  }

  /**
   * True iff the local player is currently inside a charge window. The
   * failsafe checks `LOCAL_CHARGE_FAILSAFE_MS` of wall-clock against the
   * stored start: a `charge-started` that never receives a resolution
   * unlocks here so the player is never stranded.
   *
   * Logs a one-shot `console.warn` the first time the failsafe trips for
   * a given charge so a dropped-resolution-packet bug surfaces in the
   * console rather than silently fudging the UX.
   */
  isLocalCharging(): boolean {
    if (this.chargeStartMs === null) return false;
    const elapsed = this.now() - this.chargeStartMs;
    if (elapsed >= LOCAL_CHARGE_FAILSAFE_MS) {
      console.warn(
        `[attack] local charge failsafe fired after ${elapsed.toFixed(
          0,
        )} ms — no strike resolution arrived within ${LOCAL_CHARGE_FAILSAFE_MS} ms`,
      );
      this.chargeStartMs = null;
      return false;
    }
    return true;
  }

  /**
   * Drop any in-flight charge. Called on local-player reassign (reconnect,
   * identity change) so a fresh session never inherits a stale lock from
   * the previous one.
   */
  reset(): void {
    this.chargeStartMs = null;
  }
}
