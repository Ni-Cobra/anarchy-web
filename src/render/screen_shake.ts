/**
 * Transient camera-perturbation generator for the damage-feedback flow
 * (task 120). The session detects a local-HP drop, maps the damage to a
 * peak magnitude / duration via the helpers below, calls `trigger(...)`,
 * and the renderer samples `offsetAt(nowMs)` once per frame to perturb
 * the camera position. Pure tile-space output — the renderer maps it onto
 * scene axes itself.
 *
 * Source-agnostic by design: task 130 wires the attacker's own strike-
 * shake through this same surface without further plumbing.
 *
 * Direction is computed from `nowMs` via two `sin`/`cos` curves at
 * incommensurate frequencies — deterministic, so a unit test can pin the
 * offset value without mocking `Math.random`, and visually smoother than
 * white noise because there's a continuous curve underneath.
 *
 * Decay is linear from `magnitudeTiles` at the start to `0` at
 * `startMs + durationMs`. Overlapping triggers take the max magnitude
 * and the longer remaining duration — summing under rapid hits feels
 * gross.
 *
 * Failsafe: `MAX_SHAKE_TILES` clamps even an absurd input so a one-shot
 * kill blow cannot eject the camera from the local-player focus.
 */

/** Peak shake magnitude floor — even a 1-HP poke is barely a wobble. */
const MIN_SHAKE_TILES = 0.05;
/** Peak shake magnitude ceiling — clamps the camera from leaving focus. */
const MAX_SHAKE_TILES = 0.35;
/** Duration floor — shake reads as a real perturbation rather than a flicker. */
const MIN_SHAKE_DURATION_MS = 120;
/** Duration ceiling — shake decays before the next snapshot-buffer frame. */
const MAX_SHAKE_DURATION_MS = 350;
/**
 * Damage value that saturates the magnitude / duration curves. Mirrors
 * `MAX_PLAYER_HEALTH` so a one-hit kill saturates without coupling this
 * module to the game-state max.
 */
const DAMAGE_FOR_MAX_SHAKE = 100;

/**
 * Incommensurate angular frequencies (radians / ms) for the deterministic
 * direction lookup. Pinned to `0.07` / `0.11` so the two axes don't beat
 * into each other on a short window — the resulting motion reads as a
 * smooth jitter rather than a synced wobble.
 */
const FREQ_X = 0.07;
const FREQ_Y = 0.11;

export interface ScreenShakeOffset {
  readonly dx: number;
  readonly dy: number;
}

interface ActiveShake {
  startMs: number;
  magnitudeTiles: number;
  durationMs: number;
}

export class ScreenShake {
  private active: ActiveShake | null = null;

  /**
   * Trigger a new shake at `startMs` with the given peak magnitude (tiles)
   * and duration (ms). The magnitude is clamped to `MAX_SHAKE_TILES` so a
   * giant input can't eject the camera; the duration is clamped to >= 0.
   *
   * Overlapping triggers compose:
   *   - magnitude → `max(current, new)` (no summing)
   *   - duration → `max(remaining, new)` (longer of the two)
   * and re-anchor `startMs` to the new trigger time so the merged shake
   * decays linearly from the merged amplitude.
   */
  trigger(magnitudeTiles: number, durationMs: number, startMs: number): void {
    const clampedMag = Math.min(Math.max(magnitudeTiles, 0), MAX_SHAKE_TILES);
    const clampedDur = Math.max(durationMs, 0);
    if (this.active === null) {
      this.active = {
        startMs,
        magnitudeTiles: clampedMag,
        durationMs: clampedDur,
      };
      return;
    }
    const current = this.active;
    const elapsed = startMs - current.startMs;
    if (elapsed >= current.durationMs) {
      this.active = {
        startMs,
        magnitudeTiles: clampedMag,
        durationMs: clampedDur,
      };
      return;
    }
    const remaining = current.durationMs - Math.max(elapsed, 0);
    this.active = {
      startMs,
      magnitudeTiles: Math.max(current.magnitudeTiles, clampedMag),
      durationMs: Math.max(remaining, clampedDur),
    };
  }

  /**
   * Sample the offset at `nowMs`. Returns `(0, 0)` when no shake is active
   * or the window has fully decayed. Amplitude is `magnitudeTiles * (1 - t)`
   * with `t = (nowMs - startMs) / durationMs`; direction is determined by
   * two phase-offset sinusoids at incommensurate frequencies so the offset
   * is deterministic.
   */
  offsetAt(nowMs: number): ScreenShakeOffset {
    const a = this.active;
    if (a === null) return { dx: 0, dy: 0 };
    const elapsed = nowMs - a.startMs;
    if (elapsed < 0 || elapsed >= a.durationMs) return { dx: 0, dy: 0 };
    const t = a.durationMs === 0 ? 1 : elapsed / a.durationMs;
    const amplitude = a.magnitudeTiles * (1 - t);
    return {
      dx: amplitude * Math.sin(nowMs * FREQ_X),
      dy: amplitude * Math.cos(nowMs * FREQ_Y),
    };
  }

  /** Drop any in-flight shake — used on local-player reassign. */
  reset(): void {
    this.active = null;
  }
}

/**
 * Map a positive damage amount to a peak shake magnitude in tiles. Linear
 * `damage / 100 * MAX_SHAKE_TILES`, clamped to `[MIN_SHAKE_TILES,
 * MAX_SHAKE_TILES]`. `damage <= 0` returns `0` so an inert HP refresh
 * never re-triggers a shake.
 */
export function magnitudeForDamage(damage: number): number {
  if (damage <= 0) return 0;
  const raw = (damage / DAMAGE_FOR_MAX_SHAKE) * MAX_SHAKE_TILES;
  return Math.min(Math.max(raw, MIN_SHAKE_TILES), MAX_SHAKE_TILES);
}

/**
 * Map a positive damage amount to a shake duration in milliseconds.
 * `damage / 100 * MAX_SHAKE_DURATION_MS + MIN_SHAKE_DURATION_MS`, clamped
 * to `[MIN_SHAKE_DURATION_MS, MAX_SHAKE_DURATION_MS]`. `damage <= 0`
 * returns `0`.
 */
export function durationForDamage(damage: number): number {
  if (damage <= 0) return 0;
  const raw =
    (damage / DAMAGE_FOR_MAX_SHAKE) * MAX_SHAKE_DURATION_MS +
    MIN_SHAKE_DURATION_MS;
  return Math.min(
    Math.max(raw, MIN_SHAKE_DURATION_MS),
    MAX_SHAKE_DURATION_MS,
  );
}

/**
 * Tuning constants exposed for unit tests so the assertions can pin
 * thresholds without re-deriving them from the formula.
 */
export const SCREEN_SHAKE_TUNING = {
  MIN_SHAKE_TILES,
  MAX_SHAKE_TILES,
  MIN_SHAKE_DURATION_MS,
  MAX_SHAKE_DURATION_MS,
  DAMAGE_FOR_MAX_SHAKE,
} as const;
