import type { PlayerId } from "./player.js";

/**
 * One observation: the position a player held at `timeMs` (wall-clock when
 * the snapshot arrived locally — no server-clock sync needed).
 */
export interface Sample {
  readonly timeMs: number;
  readonly x: number;
  readonly y: number;
}

const DEFAULT_CAPACITY = 16;

/**
 * Per-player ring of recent positions for render-time interpolation. Tile
 * coordinates from the server are integers; samples are stored as numbers
 * because `sample()` returns interpolated floats between bracketing
 * observations.
 *
 * Per ADR 0001 there is no client-side prediction: `sample(t)` clamps to
 * the newest known position when `t` is beyond the latest snapshot rather
 * than extrapolating.
 */
export class SnapshotBuffer {
  private readonly samplesById = new Map<PlayerId, Sample[]>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(2, capacity);
  }

  /**
   * Record `(x, y)` for `id` at wall-clock `timeMs`. Caller must push in
   * non-decreasing `timeMs` order; an out-of-order push (same or earlier
   * timestamp than the latest) overwrites the latest sample so a duplicate
   * frame can't poison the buffer.
   */
  push(id: PlayerId, x: number, y: number, timeMs: number): void {
    let list = this.samplesById.get(id);
    if (!list) {
      list = [];
      this.samplesById.set(id, list);
    }
    if (list.length > 0 && list[list.length - 1].timeMs >= timeMs) {
      list[list.length - 1] = { timeMs, x, y };
      return;
    }
    list.push({ timeMs, x, y });
    if (list.length > this.capacity) list.shift();
  }

  /** Drop all history for `id` — call on `PlayerDespawned`. */
  drop(id: PlayerId): void {
    this.samplesById.delete(id);
  }

  /** Drop everything — call on reconnect / fresh `ServerWelcome`. */
  clear(): void {
    this.samplesById.clear();
  }

  /**
   * Position at `timeMs`:
   *   - `null` if no samples for `id`,
   *   - oldest sample if `timeMs` precedes it (player just appeared),
   *   - newest sample if `timeMs` is past it (no extrapolation),
   *   - linear interpolation between the two bracketing samples otherwise.
   */
  sample(id: PlayerId, timeMs: number): { x: number; y: number } | null {
    const list = this.samplesById.get(id);
    if (!list || list.length === 0) return null;
    const first = list[0];
    if (timeMs <= first.timeMs) return { x: first.x, y: first.y };
    const last = list[list.length - 1];
    if (timeMs >= last.timeMs) return { x: last.x, y: last.y };
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      if (b.timeMs >= timeMs) {
        const a = list[i - 1];
        const span = b.timeMs - a.timeMs;
        if (span <= 0) return { x: b.x, y: b.y };
        const t = (timeMs - a.timeMs) / span;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
    }
    return { x: last.x, y: last.y };
  }

  /** Test-only inspector. Returns a snapshot of the current samples for `id`. */
  samplesOf(id: PlayerId): readonly Sample[] {
    return this.samplesById.get(id) ?? [];
  }
}
