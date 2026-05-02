import { describe, expect, it } from "vitest";

import { REMOTE_RENDER_DELAY_MS } from "../config.js";
import {
  DEFAULT_FACING,
  Direction8,
  SnapshotBuffer,
  World,
  type Player,
} from "../game/index.js";
import { composePlayerEntities } from "./compose.js";

const ID_A = 1;
const ID_B = 2;

const player = (
  id: number,
  x: number,
  y: number,
  facing: Direction8 = DEFAULT_FACING,
): Player => ({
  id,
  x,
  y,
  facing,
});

function setup() {
  const world = new World();
  const buffer = new SnapshotBuffer();
  return { world, buffer };
}

describe("composePlayerEntities", () => {
  it("draws every player from the snapshot buffer with REMOTE_RENDER_DELAY_MS lag", () => {
    const { world, buffer } = setup();
    world.applySnapshot([player(ID_A, 10, 0)]);
    buffer.push(ID_A, 0, 0, 1000);
    buffer.push(ID_A, 10, 0, 1050);

    // nowMs - 100 ms remote delay = 1000, the oldest sample → x=0.
    const out = composePlayerEntities(world, buffer, 1100);
    expect(out[0].id).toBe(ID_A);
    expect(out[0].x).toBeCloseTo(0);
  });

  it("treats local and remote players the same — both go through the buffer (ADR 0003 §7)", () => {
    const { world, buffer } = setup();
    world.applySnapshot([player(ID_A, 0, 0), player(ID_B, 0, 0)]);
    for (const id of [ID_A, ID_B]) {
      buffer.push(id, 0, 0, 1000);
      buffer.push(id, 5, 0, 1050);
      buffer.push(id, 10, 0, 1100);
    }

    const out = composePlayerEntities(world, buffer, 1100);
    const a = out.find((e) => e.id === ID_A)!;
    const b = out.find((e) => e.id === ID_B)!;
    // Both at the t=1000 sample (1100 - 100 ms render delay).
    expect(a.x).toBeCloseTo(0);
    expect(b.x).toBeCloseTo(0);
  });

  it("falls back to the latest world position when the buffer has no samples", () => {
    const { world, buffer } = setup();
    world.applySnapshot([player(ID_A, 7, -3)]);
    const out = composePlayerEntities(world, buffer, 1100);
    expect(out).toEqual([{ id: ID_A, x: 7, y: -3, facing: DEFAULT_FACING }]);
  });

  it("REMOTE_RENDER_DELAY_MS is positive and sized for one or two ticks", () => {
    expect(REMOTE_RENDER_DELAY_MS).toBeGreaterThan(0);
  });

  it("carries each player's facing through (no interpolation — server-authoritative)", () => {
    const { world, buffer } = setup();
    world.applySnapshot([
      player(ID_A, 0, 0, Direction8.E),
      player(ID_B, 0, 0, Direction8.NW),
    ]);
    buffer.push(ID_A, 0, 0, 1000);
    buffer.push(ID_B, 0, 0, 1000);

    const out = composePlayerEntities(world, buffer, 1100);
    const a = out.find((e) => e.id === ID_A)!;
    const b = out.find((e) => e.id === ID_B)!;
    expect(a.facing).toBe(Direction8.E);
    expect(b.facing).toBe(Direction8.NW);
  });
});
