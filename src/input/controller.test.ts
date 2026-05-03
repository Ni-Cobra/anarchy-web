import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InputController, type InputSink } from "./controller.js";

interface KeyEventInit {
  code: string;
  repeat?: boolean;
}

function dispatchKey(target: EventTarget, type: "keydown" | "keyup", init: KeyEventInit): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, "code", { value: init.code });
  Object.defineProperty(e, "repeat", { value: init.repeat ?? false });
  target.dispatchEvent(e);
  return e;
}

interface SentIntent {
  dx: number;
  dy: number;
}

function makeSink() {
  const sent: SentIntent[] = [];
  const sink: InputSink = {
    sendMoveIntent(dx, dy) {
      sent.push({ dx, dy });
    },
  };
  return { sent, sink };
}

const INV_SQRT2 = 1 / Math.sqrt(2);

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

describe("InputController", () => {
  let target: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    target = new EventTarget();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a single intent on press and stops sending while held + idle", () => {
    // The state-replacing model: pressing W once produces one (0, 1) frame;
    // subsequent ticks holding the same key send nothing until either the
    // intent changes or the heartbeat timer ticks over.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    expect(sent).toEqual([]); // emit only happens on tick

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([{ dx: 0, dy: 1 }]);

    // Two more ticks while still holding W — same intent, no resend yet
    // (heartbeat is at 10 ticks).
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([{ dx: 0, dy: 1 }]);

    stop();
  });

  it("emits a stop frame when the key is released", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyD" });
    vi.advanceTimersByTime(50);
    dispatchKey(target, "keyup", { code: "KeyD" });
    vi.advanceTimersByTime(50);

    expect(sent).toEqual([
      { dx: 1, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
    stop();
  });

  it("normalizes diagonal holds to unit magnitude", () => {
    // W+D held simultaneously: raw vector (1, 1), normalized to
    // (≈0.7071, ≈0.7071) so diagonal speed equals straight speed.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    dispatchKey(target, "keydown", { code: "KeyD" });
    vi.advanceTimersByTime(50);

    expect(sent).toHaveLength(1);
    expect(near(sent[0].dx, INV_SQRT2)).toBe(true);
    expect(near(sent[0].dy, INV_SQRT2)).toBe(true);
    expect(near(Math.hypot(sent[0].dx, sent[0].dy), 1)).toBe(true);

    stop();
  });

  it("opposing keys cancel to zero intent", () => {
    // W and S held together → (0, 0) — the player is "trying to move both
    // ways", which is the same as not moving.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    vi.advanceTimersByTime(50);
    dispatchKey(target, "keydown", { code: "KeyS" });
    vi.advanceTimersByTime(50);

    expect(sent).toEqual([
      { dx: 0, dy: 1 }, // W alone
      { dx: 0, dy: 0 }, // W+S cancels
    ]);
    stop();
  });

  it("resends current intent at the heartbeat cadence while moving", () => {
    // Hold W for 11 ticks. The heartbeat fires every 10 ticks with the same
    // (0, 1) so a dropped frame can't leave the server with stale intent.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    // Tick 1: change-driven send.
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([{ dx: 0, dy: 1 }]);

    // 9 more ticks: no extra send (still tick 10 from start of held state).
    vi.advanceTimersByTime(50 * 9);
    expect(sent).toEqual([{ dx: 0, dy: 1 }]);

    // Tick 11: heartbeat resend fires.
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([
      { dx: 0, dy: 1 },
      { dx: 0, dy: 1 },
    ]);

    stop();
  });

  it("does not heartbeat when intent is zero", () => {
    // Idle player — held set is empty, intent is (0, 0). No heartbeat
    // resend is needed: the server is the authoritative state and zero is
    // its default; no liveness concern.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    vi.advanceTimersByTime(50 * 30);
    expect(sent).toEqual([]);

    stop();
  });

  it("treats OS auto-repeat keydowns as held-state evidence", () => {
    // OS auto-repeat (`ke.repeat = true`) is accepted: it's a no-op while
    // the key is genuinely held (the held Set is idempotent) but it
    // recovers `held` if anything (a browser focus glitch, an X11
    // auto-repeat keyup, etc.) emptied it transiently. Without this the
    // player would stop moving until they released and re-pressed.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW", repeat: false });
    dispatchKey(target, "keydown", { code: "KeyW", repeat: true });
    dispatchKey(target, "keydown", { code: "KeyW", repeat: true });

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([{ dx: 0, dy: 1 }]);

    // Simulate a spurious keyup mid-hold (e.g. an X11 auto-repeat that
    // delivers keyup-keydown pairs). The next auto-repeat keydown must
    // refill `held` so movement resumes without waiting for the user to
    // release and re-press.
    dispatchKey(target, "keyup", { code: "KeyW" });
    vi.advanceTimersByTime(50); // stop frame
    expect(sent).toEqual([
      { dx: 0, dy: 1 },
      { dx: 0, dy: 0 },
    ]);

    sent.length = 0;
    dispatchKey(target, "keydown", { code: "KeyW", repeat: true });
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([{ dx: 0, dy: 1 }]);

    stop();
  });

  it("ignores keys that aren't movement bindings", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "Space" });
    dispatchKey(target, "keydown", { code: "Tab" });
    vi.advanceTimersByTime(200);

    expect(sent).toEqual([]);
    stop();
  });

  it("calls preventDefault for arrow keys but not for WASD", () => {
    const { sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    const arrow = dispatchKey(target, "keydown", { code: "ArrowUp" });
    const wasd = dispatchKey(target, "keydown", { code: "KeyW" });

    expect(arrow.defaultPrevented).toBe(true);
    expect(wasd.defaultPrevented).toBe(false);
    stop();
  });

  it("teardown removes listeners and stops the tick", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    stop();
    vi.advanceTimersByTime(500);
    dispatchKey(target, "keydown", { code: "KeyD" });
    vi.advanceTimersByTime(500);

    expect(sent).toEqual([]);
  });

  it("can be re-started after teardown", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop1 = ctrl.start(target);
    stop1();

    const stop2 = ctrl.start(target);
    dispatchKey(target, "keydown", { code: "KeyA" });
    vi.advanceTimersByTime(50);

    expect(sent).toEqual([{ dx: -1, dy: 0 }]);
    stop2();
  });

  it("refuses a double start without an intervening teardown", () => {
    const { sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);
    expect(() => ctrl.start(target)).toThrow(/already started/);
    stop();
  });
});
