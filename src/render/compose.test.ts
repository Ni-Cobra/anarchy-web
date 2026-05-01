import { describe, expect, it } from "vitest";

import { SnapshotBuffer, World } from "../game/index.js";
import {
  composePlayerEntities,
  LOCAL_RENDER_DELAY_MS,
  REMOTE_RENDER_DELAY_MS,
} from "./compose.js";

const LOCAL = 1;
const REMOTE = 2;

function setup() {
  const world = new World();
  const buffer = new SnapshotBuffer();
  return { world, buffer };
}

describe("composePlayerEntities", () => {
  it("uses LOCAL_RENDER_DELAY_MS for the local player", () => {
    const { world, buffer } = setup();
    world.applySnapshot([{ id: LOCAL, x: 10, y: 0 }]);
    // Two snapshots one tick apart: 0,0 at t=1000 and 10,0 at t=1050.
    buffer.push(LOCAL, 0, 0, 1000);
    buffer.push(LOCAL, 10, 0, 1050);

    // Frame at nowMs=1100 with the default 50 ms local delay queries the
    // buffer at t=1050, which is exactly the latest sample → x=10.
    const a = composePlayerEntities(world, buffer, LOCAL, 1100);
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe(LOCAL);
    expect(a[0].x).toBeCloseTo(10);

    // Frame at nowMs=1075 queries t=1025 — midway between the two samples,
    // so the local player is rendered at x=5 even though the latest server
    // snapshot already says x=10.
    const b = composePlayerEntities(world, buffer, LOCAL, 1075);
    expect(b[0].x).toBeCloseTo(5);
  });

  it("uses REMOTE_RENDER_DELAY_MS for non-local players", () => {
    const { world, buffer } = setup();
    world.applySnapshot([{ id: REMOTE, x: 10, y: 0 }]);
    buffer.push(REMOTE, 0, 0, 1000);
    buffer.push(REMOTE, 10, 0, 1050);

    // nowMs - 100 ms remote delay = 1000, the oldest sample → x=0.
    const out = composePlayerEntities(world, buffer, LOCAL, 1100);
    expect(out[0].id).toBe(REMOTE);
    expect(out[0].x).toBeCloseTo(0);
  });

  it("applies the right delay per id when both kinds are present", () => {
    const { world, buffer } = setup();
    world.applySnapshot([
      { id: LOCAL, x: 0, y: 0 },
      { id: REMOTE, x: 0, y: 0 },
    ]);
    // Same trajectory for both: 0 at 1000, 5 at 1050, 10 at 1100.
    for (const id of [LOCAL, REMOTE]) {
      buffer.push(id, 0, 0, 1000);
      buffer.push(id, 5, 0, 1050);
      buffer.push(id, 10, 0, 1100);
    }

    // At nowMs=1100: local (delay 50) → t=1050 → x=5;
    //                 remote (delay 100) → t=1000 → x=0.
    const out = composePlayerEntities(world, buffer, LOCAL, 1100);
    const local = out.find((e) => e.id === LOCAL)!;
    const remote = out.find((e) => e.id === REMOTE)!;
    expect(local.x).toBeCloseTo(5);
    expect(remote.x).toBeCloseTo(0);
  });

  it("treats every player as remote when localPlayerId is null", () => {
    const { world, buffer } = setup();
    world.applySnapshot([{ id: LOCAL, x: 0, y: 0 }]);
    buffer.push(LOCAL, 0, 0, 1000);
    buffer.push(LOCAL, 10, 0, 1050);

    // Without a local id, the player flows through the remote-delay path:
    // 1100 - 100 = 1000 → x=0.
    const out = composePlayerEntities(world, buffer, null, 1100);
    expect(out[0].x).toBeCloseTo(0);
  });

  it("falls back to the latest world position when the buffer has no samples", () => {
    const { world, buffer } = setup();
    world.applySnapshot([{ id: LOCAL, x: 7, y: -3 }]);
    // Buffer empty for LOCAL — only possible right after spawn.
    const out = composePlayerEntities(world, buffer, LOCAL, 1100);
    expect(out).toEqual([{ id: LOCAL, x: 7, y: -3 }]);
  });

  it("interpolates at the browser frame rate between snapshot ticks", () => {
    // Demonstrates the visual smoothness gain: between two snapshots that
    // land 50 ms apart, sequential render frames every ~16 ms produce a
    // monotonically advancing position rather than a single jump.
    const { world, buffer } = setup();
    world.applySnapshot([{ id: LOCAL, x: 10, y: 0 }]);
    buffer.push(LOCAL, 0, 0, 1000);
    buffer.push(LOCAL, 10, 0, 1050);

    const xs: number[] = [];
    for (const t of [1050, 1066, 1082, 1098]) {
      const out = composePlayerEntities(world, buffer, LOCAL, t);
      xs.push(out[0].x);
    }
    // Strictly increasing across frames; first frame is at t-50=1000 (x=0),
    // last is at t-50=1048 (x≈9.6).
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
    expect(xs[0]).toBeCloseTo(0);
    expect(xs[xs.length - 1]).toBeGreaterThan(9);
  });

  it("exposes sane defaults for the two render delays", () => {
    expect(LOCAL_RENDER_DELAY_MS).toBeLessThan(REMOTE_RENDER_DELAY_MS);
    expect(LOCAL_RENDER_DELAY_MS).toBeGreaterThan(0);
  });
});
