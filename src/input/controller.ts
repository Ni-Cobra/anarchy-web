import { anarchy } from "../gen/anarchy.js";
import { keyToAction, SCROLL_KEY_CODES } from "./keymap.js";

/**
 * Where the controller sends a fired action. The wire layer (`net.ts`)
 * supplies one of these so the controller stays protobuf/WebSocket-free.
 */
export interface InputSink {
  sendAction(action: anarchy.v1.ActionKind): void;
}

/**
 * 20 Hz matches the server tick (ADR 0001): one held-key emit per tick
 * gives the server exactly one tile-step worth of intent per simulation
 * frame. Far below the 30/s + burst 60 per-connection action limit on the
 * server for any single direction; sustained dual-direction holds (e.g.
 * W+D for diagonals) sit just above sustained limit but inside the burst.
 */
const DEFAULT_TICK_INTERVAL_MS = 50;

/**
 * Tracks which movement keys are held and pumps a `ClientAction` into `sink`
 * for each held direction every `tickIntervalMs`.
 *
 * Per CLAUDE.md and ADR 0001 there is no client-side prediction: pressing a
 * key only sends intent — the local player position only updates when a
 * `StateUpdate` snapshot from the server says so.
 *
 * The controller binds to an `EventTarget` (typically `window`) supplied by
 * the caller. Tests dispatch synthesized events on a custom `EventTarget`,
 * which keeps the module unit-testable without a DOM.
 */
export class InputController {
  private readonly held = new Set<anarchy.v1.ActionKind>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private bound: { target: EventTarget; down: EventListener; up: EventListener } | null = null;

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
      const action = keyToAction(ke.code);
      if (action === undefined) return;
      if (SCROLL_KEY_CODES.has(ke.code)) ke.preventDefault();
      this.held.add(action);
    };
    const up: EventListener = (e) => {
      const ke = e as KeyboardEvent;
      const action = keyToAction(ke.code);
      if (action === undefined) return;
      this.held.delete(action);
    };

    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    this.bound = { target, down, up };

    this.intervalHandle = setInterval(() => this.flush(), this.tickIntervalMs);

    return () => this.stop();
  }

  /**
   * Emit one `ClientAction` per currently-held direction. Public so tests
   * can drive the flush deterministically without waiting on the interval.
   */
  flush(): void {
    for (const action of this.held) {
      this.sink.sendAction(action);
    }
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
  }
}
