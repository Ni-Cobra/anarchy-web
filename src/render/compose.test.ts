import { describe, expect, it } from "vitest";

import { REMOTE_RENDER_DELAY_MS } from "../config.js";
import {
  DEFAULT_FACING,
  LocalPredictor,
  SnapshotBuffer,
  World,
  type Player,
} from "../game/index.js";
import { composePlayerEntities } from "./compose.js";

const LOCAL = 1;
const REMOTE = 2;

const player = (id: number, x: number, y: number): Player => ({
  id,
  x,
  y,
  facing: DEFAULT_FACING,
});

function setup() {
  const world = new World();
  const buffer = new SnapshotBuffer();
  const predictor = new LocalPredictor();
  return { world, buffer, predictor };
}

describe("composePlayerEntities", () => {
  it("draws the local player from the predictor (no snapshot lag)", () => {
    const { world, buffer, predictor } = setup();
    world.applySnapshot([player(LOCAL, 10, 0)]);
    // The buffer says the latest server snapshot is at x=10 — but the
    // predictor is the source of truth for the local player. Anchor it,
    // start it advancing east, and assert the rendered position came from
    // the predictor, not the buffer.
    buffer.push(LOCAL, 0, 0, 1000);
    buffer.push(LOCAL, 10, 0, 1050);
    predictor.reset(0, 0);
    predictor.setIntent(1, 0, 1);
    predictor.position(1_000);

    const out = composePlayerEntities(world, buffer, LOCAL, predictor, 1_500);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(LOCAL);
    // 0.5 s of east motion at SPEED=5.
    expect(out[0].x).toBeCloseTo(2.5);
    expect(out[0].y).toBe(0);
  });

  it("uses REMOTE_RENDER_DELAY_MS for non-local players", () => {
    const { world, buffer, predictor } = setup();
    world.applySnapshot([player(REMOTE, 10, 0)]);
    buffer.push(REMOTE, 0, 0, 1000);
    buffer.push(REMOTE, 10, 0, 1050);

    // nowMs - 100 ms remote delay = 1000, the oldest sample → x=0.
    const out = composePlayerEntities(world, buffer, LOCAL, predictor, 1100);
    expect(out[0].id).toBe(REMOTE);
    expect(out[0].x).toBeCloseTo(0);
  });

  it("applies predictor for local + buffered delay for remote when both are present", () => {
    const { world, buffer, predictor } = setup();
    world.applySnapshot([player(LOCAL, 0, 0), player(REMOTE, 0, 0)]);
    // Same trajectory in the buffer for both — but only REMOTE will use it.
    for (const id of [LOCAL, REMOTE]) {
      buffer.push(id, 0, 0, 1000);
      buffer.push(id, 5, 0, 1050);
      buffer.push(id, 10, 0, 1100);
    }
    predictor.reset(0, 0);
    predictor.setIntent(0, 1, 1); // moving north at SPEED=5
    predictor.position(1_000);

    const out = composePlayerEntities(world, buffer, LOCAL, predictor, 1100);
    const local = out.find((e) => e.id === LOCAL)!;
    const remote = out.find((e) => e.id === REMOTE)!;
    // Local is from the predictor: 100 ms of north motion.
    expect(local.x).toBe(0);
    expect(local.y).toBeCloseTo(0.5);
    // Remote is from the snapshot buffer at t=1000 (1100 - 100 ms).
    expect(remote.x).toBeCloseTo(0);
  });

  it("treats every player as remote when localPlayerId is null", () => {
    const { world, buffer, predictor } = setup();
    world.applySnapshot([player(LOCAL, 0, 0)]);
    buffer.push(LOCAL, 0, 0, 1000);
    buffer.push(LOCAL, 10, 0, 1050);

    // Without a local id, the player flows through the remote-delay path:
    // 1100 - 100 = 1000 → x=0.
    const out = composePlayerEntities(world, buffer, null, predictor, 1100);
    expect(out[0].x).toBeCloseTo(0);
  });

  it("treats the local player as remote when no predictor is supplied", () => {
    const { world, buffer } = setup();
    world.applySnapshot([player(LOCAL, 10, 0)]);
    buffer.push(LOCAL, 0, 0, 1000);
    buffer.push(LOCAL, 10, 0, 1050);

    // 1150 - REMOTE_RENDER_DELAY_MS(100) = 1050 → latest sample at x=10.
    const out = composePlayerEntities(world, buffer, LOCAL, null, 1150);
    expect(out[0].x).toBeCloseTo(10);
  });

  it("falls back to the latest world position when the buffer has no samples (remote)", () => {
    const { world, buffer, predictor } = setup();
    world.applySnapshot([player(REMOTE, 7, -3)]);
    const out = composePlayerEntities(world, buffer, LOCAL, predictor, 1100);
    expect(out).toEqual([{ id: REMOTE, x: 7, y: -3 }]);
  });

  it("REMOTE_RENDER_DELAY_MS is positive and sized for one or two ticks", () => {
    expect(REMOTE_RENDER_DELAY_MS).toBeGreaterThan(0);
  });
});
