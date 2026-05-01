import { describe, expect, it, vi } from "vitest";

import { anarchy } from "../gen/anarchy.js";
import {
  BlockType,
  CHUNK_SIZE,
  DEFAULT_FACING,
  Direction8,
  LAYER_AREA,
  LocalPredictor,
  SnapshotBuffer,
  Terrain,
  World,
  emptyChunk,
  getBlock,
  setBlock,
  type Chunk,
  type PlayerId,
} from "../game/index.js";
import {
  applyServerMessage,
  type LocalPlayerSink,
  type TerrainSink,
  type WireDeps,
} from "./wire.js";

function makeFixture(now = () => 1_000, predictor?: LocalPredictor) {
  const world = new World();
  const buffer = new SnapshotBuffer();
  const localCalls: Array<PlayerId | null> = [];
  let currentLocalId: PlayerId | null = null;
  const local: LocalPlayerSink = {
    setLocalPlayerId(id) {
      currentLocalId = id;
      localCalls.push(id);
    },
    getLocalPlayerId() {
      return currentLocalId;
    },
  };
  const deps: WireDeps = { world, buffer, local, predictor, now };
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
    expect(world.getPlayer(7)).toEqual({
      id: 7,
      x: 0,
      y: 0,
      facing: DEFAULT_FACING,
    });
    expect(world.getPlayer(8)).toEqual({
      id: 8,
      x: 3,
      y: -2,
      facing: DEFAULT_FACING,
    });
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

    expect(world.getPlayer(1)).toEqual({
      id: 1,
      x: 5,
      y: 0,
      facing: DEFAULT_FACING,
    });
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

  it("Welcome resets the predictor to the local player's authoritative spawn", () => {
    const predictor = new LocalPredictor();
    // Pre-soil the predictor as if a previous session left state on it.
    predictor.setIntent(1, 0, 99);
    predictor.position(0);
    predictor.position(2_000);

    const { deps } = makeFixture(() => 5_000, predictor);
    applyServerMessage(
      decodeRoundtrip({
        welcome: {
          playerId: 7,
          snapshot: {
            players: [
              { id: 7, x: -3.5, y: 4.25 },
              { id: 8, x: 0, y: 0 },
            ],
          },
        },
      }),
      deps,
    );

    // Predictor anchored at the local player's spawn, with seq + intent zeroed.
    expect(predictor.position(5_000)).toEqual({ x: -3.5, y: 4.25 });
    expect(predictor.intentForTest()).toEqual({ dx: 0, dy: 0 });
    expect(predictor.latestSentSeqForTest()).toBe(0);
  });

  it("StateUpdate reconciles the predictor with the local player's snapshot entry", () => {
    const predictor = new LocalPredictor();
    const { deps } = makeFixture(() => 1_000, predictor);

    // Bind the local id, anchor the predictor.
    applyServerMessage(
      decodeRoundtrip({
        welcome: { playerId: 7, snapshot: { players: [{ id: 7, x: 0, y: 0 }] } },
      }),
      deps,
    );
    // Client predicts moving east at full speed and has sent up through seq=3.
    predictor.setIntent(1, 0, 3);
    predictor.position(1_000);
    predictor.position(1_500); // advances ~2.5 along x

    // Server snapshot says we're at (15, 0) with all our inputs acked — that's
    // a clear divergence (e.g. a server override). Reconcile should snap.
    applyServerMessage(
      decodeRoundtrip({
        stateUpdate: {
          snapshot: {
            players: [{ id: 7, x: 15, y: 0, ackedClientSeq: 3 }],
          },
        },
      }),
      deps,
    );
    // After reconcile, query at the same time as last advance -> snapped.
    expect(predictor.position(1_500)).toEqual({ x: 15, y: 0 });
  });

  it("StateUpdate carries each player's facing into World", () => {
    const { world, deps } = makeFixture();
    applyServerMessage(
      decodeRoundtrip({
        stateUpdate: {
          snapshot: {
            players: [
              {
                id: 1,
                x: 0,
                y: 0,
                facing: anarchy.v1.Direction8.DIRECTION8_NE,
              },
              {
                id: 2,
                x: 1,
                y: 1,
                facing: anarchy.v1.Direction8.DIRECTION8_W,
              },
            ],
          },
        },
      }),
      deps,
    );
    expect(world.getPlayer(1)?.facing).toBe(Direction8.NE);
    expect(world.getPlayer(2)?.facing).toBe(Direction8.W);
  });

  it("StateUpdate falls back to default facing when the field is unset (UNSPECIFIED)", () => {
    const { world, deps } = makeFixture();
    applyServerMessage(
      decodeRoundtrip({
        stateUpdate: { snapshot: { players: [{ id: 1, x: 0, y: 0 }] } },
      }),
      deps,
    );
    expect(world.getPlayer(1)?.facing).toBe(DEFAULT_FACING);
  });

  describe("terrain ingest", () => {
    function terrainFixture() {
      const world = new World();
      const buffer = new SnapshotBuffer();
      const terrain = new Terrain();
      const events: Array<
        ["snapshot"] | ["loaded", number, number] | ["unloaded", number, number]
      > = [];
      const terrainSink: TerrainSink = {
        onSnapshot: () => events.push(["snapshot"]),
        onChunkLoaded: (cx, cy) => events.push(["loaded", cx, cy]),
        onChunkUnloaded: (cx, cy) => events.push(["unloaded", cx, cy]),
      };
      const local: LocalPlayerSink = {
        setLocalPlayerId: () => {},
        getLocalPlayerId: () => null,
      };
      const deps: WireDeps = {
        world,
        buffer,
        local,
        terrain,
        terrainSink,
      };
      return { terrain, deps, events };
    }

    function uniformWireChunk(cx: number, cy: number, kind: BlockType): anarchy.v1.IChunk {
      // pbjs converts numeric BlockType enum values into wire ints directly,
      // so the client BlockType numeric value (which intentionally matches
      // the wire) doubles as the wire kind.
      const blocks: anarchy.v1.IBlock[] = new Array(LAYER_AREA);
      for (let i = 0; i < LAYER_AREA; i++) blocks[i] = { kind };
      return {
        x: cx,
        y: cy,
        ground: { blocks },
        top: { blocks: new Array(LAYER_AREA).fill({ kind: BlockType.Air }) },
      };
    }

    it("TerrainSnapshot replaces the local terrain map and fires onSnapshot", () => {
      const { terrain, deps, events } = terrainFixture();
      // Pre-soil with a stale chunk so the wire layer's full-clear path
      // is exercised (defensive against reconnect leftovers).
      terrain.insert(99, 99, emptyChunk());

      applyServerMessage(
        decodeRoundtrip({
          terrainSnapshot: {
            chunks: [
              uniformWireChunk(-1, -1, BlockType.Stone),
              uniformWireChunk(0, 0, BlockType.Grass),
            ],
          },
        }),
        deps,
      );

      expect(terrain.size()).toBe(2);
      expect(terrain.contains(99, 99)).toBe(false);
      expect(getBlock(terrain.get(-1, -1)!.ground, 0, 0).kind).toBe(BlockType.Stone);
      expect(getBlock(terrain.get(0, 0)!.ground, 5, 5).kind).toBe(BlockType.Grass);
      expect(events).toEqual([["snapshot"]]);
    });

    it("ChunkLoaded inserts/replaces a single chunk and fires onChunkLoaded", () => {
      const { terrain, deps, events } = terrainFixture();
      // First load.
      applyServerMessage(
        decodeRoundtrip({
          chunkLoaded: { chunk: uniformWireChunk(2, -3, BlockType.Wood) },
        }),
        deps,
      );
      expect(terrain.size()).toBe(1);
      expect(getBlock(terrain.get(2, -3)!.ground, 7, 9).kind).toBe(BlockType.Wood);

      // Replacement at the same coord — server is authoritative; client must
      // overwrite without crashing.
      applyServerMessage(
        decodeRoundtrip({
          chunkLoaded: { chunk: uniformWireChunk(2, -3, BlockType.Stone) },
        }),
        deps,
      );
      expect(terrain.size()).toBe(1);
      expect(getBlock(terrain.get(2, -3)!.ground, 7, 9).kind).toBe(BlockType.Stone);
      expect(events).toEqual([
        ["loaded", 2, -3],
        ["loaded", 2, -3],
      ]);
    });

    it("ChunkUnloaded removes the chunk and fires onChunkUnloaded; idempotent on missing", () => {
      const { terrain, deps, events } = terrainFixture();
      terrain.insert(4, 5, emptyChunk());
      applyServerMessage(
        decodeRoundtrip({ chunkUnloaded: { x: 4, y: 5 } }),
        deps,
      );
      expect(terrain.contains(4, 5)).toBe(false);
      // Removing a chunk we don't have must not crash — duplicate broadcast
      // (e.g. across a join race) is a real wire condition.
      applyServerMessage(
        decodeRoundtrip({ chunkUnloaded: { x: 4, y: 5 } }),
        deps,
      );
      expect(terrain.contains(4, 5)).toBe(false);
      expect(events).toEqual([
        ["unloaded", 4, 5],
        ["unloaded", 4, 5],
      ]);
    });

    it("ChunkLoaded with a malformed layer (wrong block count) is silently ignored", () => {
      // Defense in depth: proto3 has no fixed-size repeated, so a stray
      // 250-block layer must not crash the client. The terrain stays
      // unchanged and the sink is not notified.
      const { terrain, deps, events } = terrainFixture();
      const bad: anarchy.v1.IChunk = {
        x: 1,
        y: 1,
        ground: { blocks: new Array(250).fill({ kind: BlockType.Grass }) },
        top: { blocks: new Array(LAYER_AREA).fill({ kind: BlockType.Air }) },
      };
      applyServerMessage(
        decodeRoundtrip({ chunkLoaded: { chunk: bad } }),
        deps,
      );
      expect(terrain.size()).toBe(0);
      expect(events).toEqual([]);
    });

    it("preserves per-tile kinds when round-tripping through the wire", () => {
      // Build a chunk with a specific tile pattern, encode it through the
      // proto layer, decode it back, and verify the per-tile kinds survive.
      const { terrain, deps } = terrainFixture();
      const c: Chunk = emptyChunk();
      setBlock(c.ground, 0, 0, { kind: BlockType.Grass });
      setBlock(c.ground, CHUNK_SIZE - 1, CHUNK_SIZE - 1, { kind: BlockType.Stone });
      setBlock(c.top, 7, 7, { kind: BlockType.Wood });

      // Convert in-memory chunk → wire IChunk by mirroring layer_to_wire.
      const groundBlocks: anarchy.v1.IBlock[] = new Array(LAYER_AREA);
      const topBlocks: anarchy.v1.IBlock[] = new Array(LAYER_AREA);
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          groundBlocks[y * CHUNK_SIZE + x] = { kind: getBlock(c.ground, x, y).kind };
          topBlocks[y * CHUNK_SIZE + x] = { kind: getBlock(c.top, x, y).kind };
        }
      }
      applyServerMessage(
        decodeRoundtrip({
          chunkLoaded: {
            chunk: {
              x: 3,
              y: -4,
              ground: { blocks: groundBlocks },
              top: { blocks: topBlocks },
            },
          },
        }),
        deps,
      );

      const recovered = terrain.get(3, -4)!;
      expect(getBlock(recovered.ground, 0, 0).kind).toBe(BlockType.Grass);
      expect(
        getBlock(recovered.ground, CHUNK_SIZE - 1, CHUNK_SIZE - 1).kind,
      ).toBe(BlockType.Stone);
      expect(getBlock(recovered.top, 7, 7).kind).toBe(BlockType.Wood);
      // Default-constructed Air tiles survive too.
      expect(getBlock(recovered.ground, 5, 5).kind).toBe(BlockType.Air);
    });

    it("terrain payloads are no-ops when no Terrain is bound", () => {
      const world = new World();
      const buffer = new SnapshotBuffer();
      const local: LocalPlayerSink = {
        setLocalPlayerId: () => {},
        getLocalPlayerId: () => null,
      };
      const deps: WireDeps = { world, buffer, local };
      // Should not throw despite missing terrain.
      applyServerMessage(
        decodeRoundtrip({
          terrainSnapshot: { chunks: [uniformWireChunk(0, 0, BlockType.Grass)] },
        }),
        deps,
      );
      applyServerMessage(
        decodeRoundtrip({
          chunkLoaded: { chunk: uniformWireChunk(1, 1, BlockType.Grass) },
        }),
        deps,
      );
      applyServerMessage(
        decodeRoundtrip({ chunkUnloaded: { x: 1, y: 1 } }),
        deps,
      );
    });
  });

  it("StateUpdate skips reconciliation when server hasn't acked the latest input", () => {
    const predictor = new LocalPredictor();
    const { deps } = makeFixture(() => 1_000, predictor);
    applyServerMessage(
      decodeRoundtrip({
        welcome: { playerId: 7, snapshot: { players: [{ id: 7, x: 0, y: 0 }] } },
      }),
      deps,
    );
    // Client has sent up through seq=10; predicted has advanced.
    predictor.setIntent(1, 0, 10);
    predictor.position(1_000);
    predictor.position(2_000); // ~5 along x at SPEED=5

    // Server still only acked seq=2 — predicted is correctly ahead. Don't snap.
    applyServerMessage(
      decodeRoundtrip({
        stateUpdate: {
          snapshot: {
            players: [{ id: 7, x: 0, y: 0, ackedClientSeq: 2 }],
          },
        },
      }),
      deps,
    );
    const pos = predictor.position(2_000);
    expect(pos.x).toBeCloseTo(5);
    expect(pos.y).toBe(0);
  });
});
