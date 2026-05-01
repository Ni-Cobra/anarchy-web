import type { Player } from "./player.js";

/**
 * World units per second. Mirrors `game::world::SPEED` on the server — the
 * two must stay equal so that predicted client motion converges with the
 * authoritative server tick. See ADR 0001 (movement-intent amendment).
 */
export const SPEED = 5.0;

/**
 * If predicted position diverges from the latest reconcilable server
 * snapshot by more than this many world units, snap to the server. Picked to
 * be larger than the typical server-vs-client lag distance for a player
 * moving at full speed (`|intent| * SPEED * RTT/2` is well under 1.0 on a
 * sub-100 ms link) but small enough that an actual override (collision,
 * future anti-cheat) gets corrected within a single tick.
 */
export const RECONCILE_SNAP_DISTANCE = 1.5;

/**
 * Local-player position predictor. Replaces snapshot-buffer rendering for
 * the local player, so input is reflected on the next frame instead of
 * after a WebSocket round-trip.
 *
 * Lifecycle:
 *   - `reset(x, y)` on `ServerWelcome` (anchors at the spawn position).
 *   - `setIntent(dx, dy, seq)` on every outbound `ClientAction` so the
 *     predictor knows the latest intent value plus the action's
 *     `client_seq`.
 *   - `position(now)` once per frame to advance the predicted position by
 *     `intent * SPEED * dt` and read the current value.
 *   - `reconcile(serverX, serverY, ackedSeq)` once per inbound
 *     `StateUpdate`, with the local player's authoritative entry. Snaps to
 *     the server position when the divergence exceeds
 *     `RECONCILE_SNAP_DISTANCE` and the server has caught up to the
 *     client's latest sent seq.
 *
 * Reconciliation policy: while `ackedSeq < latestSentSeq` the server is
 * still catching up — we keep predicting and ignore server position
 * (otherwise we'd snap back to a stale anchor). Once the server has acked
 * the latest intent, predicted and server should agree to within network/
 * tick lag; anything larger means the server overrode the client's input
 * (collision today, anti-cheat eventually) and we snap. v1 uses an
 * unconditional snap rather than smoothing — playtesting will tell us if
 * the snap is visible enough to warrant a smoothing pass.
 */
export class LocalPredictor {
  private intent = { dx: 0, dy: 0 };
  private latestSentSeq = 0;
  private predicted = { x: 0, y: 0 };
  private lastAdvancedAtMs: number | null = null;

  constructor(
    private readonly speed: number = SPEED,
    private readonly snapDistance: number = RECONCILE_SNAP_DISTANCE,
  ) {}

  /**
   * Reset to a known authoritative position. Called on `ServerWelcome` (and
   * on a future reconnect path). Clears intent + seq so we start fresh.
   */
  reset(x: number, y: number): void {
    this.intent = { dx: 0, dy: 0 };
    this.latestSentSeq = 0;
    this.predicted = { x, y };
    this.lastAdvancedAtMs = null;
  }

  /**
   * Replace the current intent and record the seq the client just sent. The
   * seq guard ensures an out-of-order callback can't roll the latest seq
   * backward; intent itself is state-replacing per ADR 0001.
   */
  setIntent(dx: number, dy: number, seq: number): void {
    this.intent = { dx, dy };
    if (seq > this.latestSentSeq) this.latestSentSeq = seq;
  }

  /**
   * Advance the predicted position by `intent * SPEED * dt` for the elapsed
   * time since the last call, and return the new value. The first call
   * after `reset` initializes the internal timer and returns the unchanged
   * predicted position.
   */
  position(nowMs: number): { x: number; y: number } {
    if (this.lastAdvancedAtMs !== null && nowMs > this.lastAdvancedAtMs) {
      const dt = (nowMs - this.lastAdvancedAtMs) / 1000;
      this.predicted = {
        x: this.predicted.x + this.intent.dx * this.speed * dt,
        y: this.predicted.y + this.intent.dy * this.speed * dt,
      };
    }
    this.lastAdvancedAtMs = nowMs;
    return { x: this.predicted.x, y: this.predicted.y };
  }

  /**
   * Reconcile predicted position against the local player's snapshot entry.
   * No-op while the server hasn't caught up to the latest sent seq —
   * predicted is correctly running ahead in that window. Otherwise snaps to
   * the authoritative position when the divergence is larger than the
   * configured threshold.
   */
  reconcile(serverX: number, serverY: number, ackedSeq: number): void {
    if (ackedSeq < this.latestSentSeq) return;
    const dx = this.predicted.x - serverX;
    const dy = this.predicted.y - serverY;
    if (Math.hypot(dx, dy) > this.snapDistance) {
      this.predicted = { x: serverX, y: serverY };
    }
  }

  /**
   * Build a renderable view of the local player using the current predicted
   * position. Convenience for the renderer's compose pass.
   */
  asPlayer(id: number, nowMs: number): Player {
    const pos = this.position(nowMs);
    return { id, x: pos.x, y: pos.y };
  }

  /** Test-only inspectors. */
  intentForTest(): { dx: number; dy: number } {
    return { ...this.intent };
  }
  latestSentSeqForTest(): number {
    return this.latestSentSeq;
  }
}
