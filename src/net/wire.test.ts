import { describe, expect, it, vi } from "vitest";

import { anarchy } from "../gen/anarchy.js";
import { SnapshotBuffer, World, type PlayerId } from "../game/index.js";
import { applyServerMessage, type LocalPlayerSink, type WireDeps } from "./wire.js";

function makeFixture(now = () => 1_000) {
  const world = new World();
  const buffer = new SnapshotBuffer();
  const localCalls: Array<PlayerId | null> = [];
  const local: LocalPlayerSink = {
    setLocalPlayerId(id) {
      localCalls.push(id);
    },
  };
  const deps: WireDeps = { world, buffer, local, now };
  return { world, buffer, localCalls, deps };
}

function decodeRoundtrip(msg: anarchy.v1.IServerMessage): anarchy.v1.ServerMessage {
  const bytes = anarchy.v1.ServerMessage.encode(
    anarchy.v1.ServerMessage.create(msg),
  ).finish();
  return anarchy.v1.ServerMessage.decode(bytes);
}

describe("applyServerMessage", () => {
  it("Welcome populates the world, seeds the buffer, and binds the local id", () => {
    const { world, buffer, localCalls, deps } = makeFixture(() => 5_000);
    const msg = decodeRoundtrip({
      seq: 1,
      welcome: {
        serverVersion: "test",
        tickRateHz: 20,
        playerId: 7,
        snapshot: {
          players: [
            { id: 7, x: 0, y: 0 },
            { id: 8, x: 3, y: -2 },
          ],
        },
      },
    });

    applyServerMessage(msg, deps);

    expect(localCalls).toEqual([7]);
    expect(world.size()).toBe(2);
    expect(world.getPlayer(7)).toEqual({ id: 7, x: 0, y: 0 });
    expect(world.getPlayer(8)).toEqual({ id: 8, x: 3, y: -2 });
    expect(buffer.sample(7, 5_000)).toEqual({ x: 0, y: 0 });
    expect(buffer.sample(8, 5_000)).toEqual({ x: 3, y: -2 });
  });

  it("a fresh Welcome clears stale buffer entries from a previous session", () => {
    const { buffer, deps } = makeFixture();
    buffer.push(99, 11, 11, 100);

    const msg = decodeRoundtrip({
      welcome: { playerId: 1, snapshot: { players: [{ id: 1, x: 0, y: 0 }] } },
    });
    applyServerMessage(msg, deps);

    expect(buffer.sample(99, 100)).toBeNull();
  });

  it("StateUpdate replaces the world and appends a fresh sample per player", () => {
    const time = vi.fn().mockReturnValue(1_000);
    const { world, buffer, deps } = makeFixture(time);

    applyServerMessage(
      decodeRoundtrip({ stateUpdate: { snapshot: { players: [{ id: 1, x: 0, y: 0 }] } } }),
      deps,
    );
    time.mockReturnValue(1_100);
    applyServerMessage(
      decodeRoundtrip({ stateUpdate: { snapshot: { players: [{ id: 1, x: 5, y: 0 }] } } }),
      deps,
    );

    expect(world.getPlayer(1)).toEqual({ id: 1, x: 5, y: 0 });
    // Midpoint between the two samples should lerp.
    const mid = buffer.sample(1, 1_050);
    expect(mid!.x).toBeCloseTo(2.5);
    expect(mid!.y).toBeCloseTo(0);
  });

  it("StateUpdate replacing the player set drops absent players from the world", () => {
    const { world, deps } = makeFixture();
    applyServerMessage(
      decodeRoundtrip({
        stateUpdate: {
          snapshot: {
            players: [
              { id: 1, x: 0, y: 0 },
              { id: 2, x: 1, y: 1 },
            ],
          },
        },
      }),
      deps,
    );
    applyServerMessage(
      decodeRoundtrip({ stateUpdate: { snapshot: { players: [{ id: 1, x: 0, y: 0 }] } } }),
      deps,
    );
    expect(world.getPlayer(2)).toBeUndefined();
  });

  it("PlayerDespawned removes the player from both world and buffer", () => {
    const { world, buffer, deps } = makeFixture();
    applyServerMessage(
      decodeRoundtrip({
        stateUpdate: {
          snapshot: {
            players: [
              { id: 1, x: 0, y: 0 },
              { id: 2, x: 4, y: 4 },
            ],
          },
        },
      }),
      deps,
    );

    applyServerMessage(
      decodeRoundtrip({ playerDespawned: { playerId: 2 } }),
      deps,
    );

    expect(world.getPlayer(2)).toBeUndefined();
    expect(buffer.sample(2, 1_000)).toBeNull();
    expect(world.getPlayer(1)).toBeDefined();
  });

  it("ignores unrelated payloads (Pong, empty)", () => {
    const { world, buffer, localCalls, deps } = makeFixture();
    applyServerMessage(decodeRoundtrip({ pong: { clientTimeMs: 1, serverTimeMs: 2 } }), deps);
    applyServerMessage(decodeRoundtrip({}), deps);
    expect(world.size()).toBe(0);
    expect(buffer.sample(1, 1_000)).toBeNull();
    expect(localCalls).toEqual([]);
  });
});
