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
  const sent: anarchy.v1.ActionKind[] = [];
  const sink: InputSink = {
    sendAction(action) {
      sent.push(action);
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

  it("emits one action per held direction on each tick", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    expect(sent).toEqual([]); // intent only emits on tick, not on press

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([ActionKind.ACTION_KIND_MOVE_NORTH]);

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([
      ActionKind.ACTION_KIND_MOVE_NORTH,
      ActionKind.ACTION_KIND_MOVE_NORTH,
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

    expect(sent).toEqual([ActionKind.ACTION_KIND_MOVE_EAST]);
    stop();
  });

  it("emits one of each held direction per tick when multiple keys are held", () => {
    const { sent, sink } = makeSink();
    const ctrl = new InputController(sink, 50);
    const stop = ctrl.start(target);

    dispatchKey(target, "keydown", { code: "KeyW" });
    dispatchKey(target, "keydown", { code: "KeyD" });
    vi.advanceTimersByTime(50);

    expect(new Set(sent)).toEqual(
      new Set([ActionKind.ACTION_KIND_MOVE_NORTH, ActionKind.ACTION_KIND_MOVE_EAST]),
    );
    expect(sent).toHaveLength(2);
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
    expect(sent).toEqual([ActionKind.ACTION_KIND_MOVE_NORTH]);

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

    expect(sent).toEqual([ActionKind.ACTION_KIND_MOVE_WEST]);
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
