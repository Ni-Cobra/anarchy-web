import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { anarchy } from "../gen/anarchy.js";
import { InputController, type InputSink } from "./controller.js";

const { ActionKind } = anarchy.v1;

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

function makeSink() {
  // Each entry is one frame's worth of actions, mirroring how the wire
  // sees them: one call per tick, even when the call carries multiple
  // held directions.
  const sent: anarchy.v1.ActionKind[][] = [];
  const sink: InputSink = {
    sendActions(actions) {
      sent.push([...actions]);
    },
  };
  return { sent, sink };
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

  it("emits one frame per tick carrying the held direction", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    expect(sent).toEqual([]); // intent only emits on tick, not on press

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([[ActionKind.ACTION_KIND_MOVE_NORTH]]);

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([
      [ActionKind.ACTION_KIND_MOVE_NORTH],
      [ActionKind.ACTION_KIND_MOVE_NORTH],
    ]);

    stop();
  });

  it("stops emitting once the key is released", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyD" });
    vi.advanceTimersByTime(50);
    dispatchKey(target, "keyup", { code: "KeyD" });
    vi.advanceTimersByTime(200);

    expect(sent).toEqual([[ActionKind.ACTION_KIND_MOVE_EAST]]);
    stop();
  });

  it("packs every held direction into a single frame per tick", () => {
    // The whole point of the multi-action wire frame: holding W+D produces
    // exactly one frame per tick, not two — see ADR 0001 + the rate-limit
    // budget in network/conn.rs.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    dispatchKey(target, "keydown", { code: "KeyD" });
    vi.advanceTimersByTime(50);

    expect(sent).toHaveLength(1);
    expect(new Set(sent[0])).toEqual(
      new Set([ActionKind.ACTION_KIND_MOVE_NORTH, ActionKind.ACTION_KIND_MOVE_EAST]),
    );
    stop();
  });

  it("does not emit a frame on ticks where nothing is held", () => {
    // Empty frames waste rate-limit budget for no reason — the controller
    // simply skips the send call when the held set is empty.
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);

    dispatchKey(target, "keydown", { code: "KeyW" });
    vi.advanceTimersByTime(50);
    dispatchKey(target, "keyup", { code: "KeyW" });
    vi.advanceTimersByTime(200);

    expect(sent).toEqual([[ActionKind.ACTION_KIND_MOVE_NORTH]]);
    stop();
  });

  it("ignores OS auto-repeat keydown events", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    // First press registers, repeated synthetic events from the OS should not
    // re-add the action — they just confirm the same held state.
    dispatchKey(target, "keydown", { code: "KeyW", repeat: false });
    dispatchKey(target, "keydown", { code: "KeyW", repeat: true });
    dispatchKey(target, "keydown", { code: "KeyW", repeat: true });

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([[ActionKind.ACTION_KIND_MOVE_NORTH]]);

    // After release, even a stray repeat=true must not re-arm the held set.
    dispatchKey(target, "keyup", { code: "KeyW" });
    sent.length = 0;
    dispatchKey(target, "keydown", { code: "KeyW", repeat: true });
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);

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

    expect(sent).toEqual([[ActionKind.ACTION_KIND_MOVE_WEST]]);
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
