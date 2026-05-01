import { keyToDirection, SCROLL_KEY_CODES } from "./keymap.js";

/**
 * Where the controller sends its current movement intent. The wire layer
 * (`net.ts`) supplies one of these so the controller stays protobuf/
 * WebSocket-free. Intent is state-replacing: a single send tells the server
 * "this is the intent now"; the server keeps applying it every tick until
 * a new value arrives.
 */
export interface InputSink {
  sendMoveIntent(dx: number, dy: number): void;
}

/**
 * 20 Hz matches the server tick (ADR 0001). The controller polls the held
 * key set this often, recomputes the intent vector, and pushes it to the
 * sink whenever it changes — plus a periodic heartbeat resend for
 * robustness against dropped frames in any future non-TCP transport.
 */
const DEFAULT_TICK_INTERVAL_MS = 50;

/**
 * Resend the current intent every N ticks even when it hasn't changed, so
 * a dropped frame can't leave the server with a stale view of the player's
 * intent for more than ~N * tickInterval. 10 ticks ≈ 500 ms.
 */
const HEARTBEAT_TICKS = 10;

/**
 * Tracks which movement keys are held and pushes a `MoveIntent` to `sink`
 * whenever the held set produces a new normalized intent vector (plus a
 * periodic heartbeat resend when the intent is non-zero).
 *
 * Per ADR 0001 (movement-intent amendment) the client never advances the
 * local player ahead of the server: pressing a key only sends intent —
 * positions still come back via `StateUpdate` snapshots.
 *
 * The controller binds to an `EventTarget` (typically `window`) supplied by
 * the caller. Tests dispatch synthesized events on a custom `EventTarget`,
 * which keeps the module unit-testable without a DOM.
 */
export class InputController {
  private readonly held = new Set<string>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private bound: { target: EventTarget; down: EventListener; up: EventListener } | null = null;
  // The server assumes a fresh player has zero intent (see `Player::new` on
  // the server), so we initialize to (0, 0) — that matches reality and keeps
  // an idle controller from emitting a redundant first frame.
  private lastSent: { dx: number; dy: number } = { dx: 0, dy: 0 };
  private heartbeatCounter = 0;

  constructor(
    private readonly sink: InputSink,
    private readonly tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS,
  ) {}

  /**
   * Bind keydown/keyup listeners to `target` and start the per-tick flush.
   * Returns a teardown closure that removes listeners, stops the timer, and
   * clears held state. Calling `start` while already started throws — the
   * controller is single-bind by design.
   */
  start(target: EventTarget): () => void {
    if (this.bound !== null) {
      throw new Error("InputController already started");
    }

    const down: EventListener = (e) => {
      const ke = e as KeyboardEvent;
      if (ke.repeat) return;
      if (keyToDirection(ke.code) === undefined) return;
      if (SCROLL_KEY_CODES.has(ke.code)) ke.preventDefault();
      this.held.add(ke.code);
    };
    const up: EventListener = (e) => {
      const ke = e as KeyboardEvent;
      if (keyToDirection(ke.code) === undefined) return;
      this.held.delete(ke.code);
    };

    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    this.bound = { target, down, up };

    this.intervalHandle = setInterval(() => this.flush(), this.tickIntervalMs);

    return () => this.stop();
  }

  /**
   * Recompute the intent from the held key set and push it to the sink iff
   * it changed (or a heartbeat is due). Public so tests can drive the flush
   * deterministically without waiting on the interval.
   */
  flush(): void {
    const intent = this.computeIntent();
    const changed = this.lastSent.dx !== intent.dx || this.lastSent.dy !== intent.dy;
    const moving = intent.dx !== 0 || intent.dy !== 0;

    this.heartbeatCounter += 1;
    const heartbeatDue = moving && this.heartbeatCounter >= HEARTBEAT_TICKS;

    if (changed || heartbeatDue) {
      this.sink.sendMoveIntent(intent.dx, intent.dy);
      this.lastSent = intent;
      this.heartbeatCounter = 0;
    }
  }

  private computeIntent(): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    for (const code of this.held) {
      const dir = keyToDirection(code);
      if (dir === undefined) continue;
      dx += dir[0];
      dy += dir[1];
    }
    // Normalize so opposing keys cancel cleanly and diagonals get unit
    // magnitude (≈0.7071 each). Cardinal holds already have magnitude 1.
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    return { dx, dy };
  }

  private stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.bound !== null) {
      this.bound.target.removeEventListener("keydown", this.bound.down);
      this.bound.target.removeEventListener("keyup", this.bound.up);
      this.bound = null;
    }
    this.held.clear();
    this.lastSent = { dx: 0, dy: 0 };
    this.heartbeatCounter = 0;
  }
}
