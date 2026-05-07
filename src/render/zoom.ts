/**
 * Camera-height tween controller. Pure math — no Three.js, no DOM — so the
 * easing curve and the mid-tween retarget rule can be unit-tested without a
 * renderer. The `Renderer` constructs one of these and samples it each
 * frame; `bootstrap.ts` drives the target via the M preset toggle and the
 * `+` / `-` / `Ctrl+Wheel` continuous-zoom bindings.
 *
 * Retarget rule: when the target changes mid-tween, the new tween's start
 * is the *currently sampled* value (not the prior tween's start). That's
 * what keeps the camera position continuous across a chain of nudges —
 * pressing `-` twice quickly should ease toward the second target without
 * a jump back to where the first tween began.
 */

import { ZOOM_HEIGHT_MAX, ZOOM_HEIGHT_MIN } from "../config.js";

/** Standard ease-in-out cubic curve over `t ∈ [0, 1]`. */
export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class ZoomController {
  private startValue: number;
  private targetValue: number;
  private startMs: number;
  private readonly duration: number;

  constructor(initial: number, duration: number, nowMs: number = 0) {
    this.startValue = initial;
    this.targetValue = initial;
    this.startMs = nowMs;
    this.duration = duration;
  }

  /**
   * Sample the camera height at `nowMs`. Eases between the most recent
   * tween's start and target along an ease-in-out cubic curve. Once the
   * tween has run past `duration` the controller stays parked at `target`
   * so subsequent samples are O(1).
   */
  sample(nowMs: number): number {
    if (this.startValue === this.targetValue) return this.targetValue;
    const elapsed = nowMs - this.startMs;
    if (elapsed >= this.duration) {
      this.startValue = this.targetValue;
      return this.targetValue;
    }
    if (elapsed <= 0) return this.startValue;
    const t = easeInOutCubic(elapsed / this.duration);
    return this.startValue + (this.targetValue - this.startValue) * t;
  }

  /**
   * Set a new target. If `target` matches the current target this is a
   * no-op (the in-flight tween keeps running). Otherwise the new tween's
   * start is anchored at the *currently sampled* value, so a retarget
   * mid-tween produces a continuous camera position.
   */
  setTarget(target: number, nowMs: number): void {
    if (target === this.targetValue) return;
    const current = this.sample(nowMs);
    this.startValue = current;
    this.targetValue = target;
    this.startMs = nowMs;
  }

  /** Latest commanded target (whether or not the tween has reached it). */
  target(): number {
    return this.targetValue;
  }

  /** True while a tween is in flight. False once the controller has parked
   * at the target (see `sample`). */
  isTweening(nowMs: number): boolean {
    if (this.startValue === this.targetValue) return false;
    return nowMs - this.startMs < this.duration;
  }
}

/**
 * Clamp a desired camera height into the configured zoom bounds. Lives
 * here next to the controller so the bootstrap binding for `+` / `-` /
 * `Ctrl+Wheel` doesn't have to reach into config + apply the same clamp
 * logic itself.
 */
export function clampZoomHeight(height: number): number {
  if (height < ZOOM_HEIGHT_MIN) return ZOOM_HEIGHT_MIN;
  if (height > ZOOM_HEIGHT_MAX) return ZOOM_HEIGHT_MAX;
  return height;
}
