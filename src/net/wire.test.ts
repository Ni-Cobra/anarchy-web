import { describe, expect, it } from "vitest";

import { anarchy } from "../gen/anarchy.js";
import {
  BlockType,
  DEFAULT_FACING,
  Direction8,
  LAYER_AREA,
  SnapshotBuffer,
  Terrain,
  World,
  emptyChunk,
  setBlock,
  type Chunk,
  type ChunkCoord,
  type PlayerId,
} from "../game/index.js";
import {
  applyServerMessage,
  type LocalPlayerSink,
  type TerrainSink,
  type WireDeps,
} from "./wire.js";

function makeFixture(now = () => 1_000) {
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
  const deps: WireDeps = { world, buffer, local, now };
  return { world, buffer, localCalls, deps };
}

function makeTerrainFixture(now = () => 1_000) {
  const base = makeFixture(now);
  const terrain = new Terrain();
  const onChunkLoaded: ChunkCoord[] = [];
  const onChunkUnloaded: ChunkCoord[] = [];
  const sink: TerrainSink = {
    onChunkLoaded(cx, cy) {
      onChunkLoaded.push([cx, cy]);
    },
    onChunkUnloaded(cx, cy) {
      onChunkUnloaded.push([cx, cy]);
    },
  };
  const deps: WireDeps = { ...base.deps, terrain, terrainSink: sink };
  return { ...base, terrain, deps, onChunkLoaded, onChunkUnloaded };
}

function decodeRoundtrip(msg: anarchy.v1.IServerMessage): anarchy.v1.ServerMessage {
  const bytes = anarchy.v1.ServerMessage.encode(
    anarchy.v1.ServerMessage.create(msg),
  ).finish();
  return anarchy.v1.ServerMessage.decode(bytes);
}

function airLayerWire(): anarchy.v1.ILayer {
  return {
    blocks: Array.from({ length: LAYER_AREA }, () => ({
      kind: anarchy.v1.BlockType.BLOCK_TYPE_AIR,
    })),
  };
}

function chunkWire(
  cx: number,
  cy: number,
  players: anarchy.v1.IPlayerSnapshot[] = [],
): anarchy.v1.IChunk {
  return {
    coord: { cx, cy },
    ground: airLayerWire(),
    top: airLayerWire(),
    players,
  };
}

function chunkFromGameWire(cx: number, cy: number, src: Chunk): anarchy.v1.IChunk {
  const layer = (l: { blocks: { kind: BlockType }[] }): anarchy.v1.ILayer => ({
    blocks: l.blocks.map((b) => ({ kind: b.kind as number as anarchy.v1.BlockType })),
  });
  const players = [...src.players.values()].map((p): anarchy.v1.IPlayerSnapshot => ({
    id: p.id,
    x: p.x,
    y: p.y,
    facing: p.facing as number as anarchy.v1.Direction8,
    username: p.username,
    colorIndex: p.colorIndex,
  }));
  return { coord: { cx, cy }, ground: layer(src.ground), top: layer(src.top), players };
}

describe("applyServerMessage — Welcome", () => {
  it("publishes the local player id and clears any prior state", () => {
    const { deps, world, buffer, localCalls } = makeFixture();
    world.applySnapshot([
      { id: 99, x: 5, y: 5, facing: DEFAULT_FACING, username: "", colorIndex: 0 },
    ]);
    buffer.push(99, 5, 5, 100);

    const msg = decodeRoundtrip({
      seq: 1,
      welcome: {
        serverVersion: "test",
        tickRateHz: 20,
        playerId: 7,
        viewRadiusChunks: 2,
      },
    });
    applyServerMessage(msg, deps);

    expect(localCalls).toEqual([7]);
    expect(world.size()).toBe(0);
    expect(buffer.knownIds()).toEqual([]);
  });

  it("clears terrain on Welcome and notifies the sink for each unload", () => {
    const { deps, terrain, onChunkUnloaded } = makeTerrainFixture();
    terrain.insert(0, 0, emptyChunk());
    terrain.insert(1, 0, emptyChunk());

    const msg = decodeRoundtrip({
      seq: 1,
      welcome: { serverVersion: "test", tickRateHz: 20, playerId: 1, viewRadiusChunks: 2 },
    });
    applyServerMessage(msg, deps);

    expect(terrain.size()).toBe(0);
    const unloaded = onChunkUnloaded.map(([cx, cy]) => `${cx},${cy}`).sort();
    expect(unloaded).toEqual(["0,0", "1,0"]);
  });
});

describe("applyServerMessage — TickUpdate", () => {
  it("applies full-state chunks to terrain and notifies the sink", () => {
    const { deps, terrain, onChunkLoaded } = makeTerrainFixture();

    const c00 = emptyChunk();
    setBlock(c00.ground, 1, 2, { kind: BlockType.Grass });
    const wire00 = chunkFromGameWire(0, 0, c00);

    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [wire00],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(msg, deps);

    expect(terrain.size()).toBe(1);
    expect(terrain.contains(0, 0)).toBe(true);
    expect(onChunkLoaded).toEqual([[0, 0]]);
  });

  it("ingests players carried inside full-state chunks into the World and pushes samples", () => {
    const { deps, world, buffer } = makeTerrainFixture(() => 5_000);
    const wire = chunkWire(0, 0, [
      { id: 1, x: 1.5, y: 2.5, facing: anarchy.v1.Direction8.DIRECTION8_E },
      { id: 2, x: -3, y: 0, facing: anarchy.v1.Direction8.DIRECTION8_N },
    ]);

    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: { fullStateChunks: [wire], unmodifiedChunks: [] },
    });
    applyServerMessage(msg, deps);

    const ids = [...world.players()].map((p) => p.id).sort();
    expect(ids).toEqual([1, 2]);
    expect(world.getPlayer(1)).toEqual({
      id: 1,
      x: 1.5,
      y: 2.5,
      facing: Direction8.E,
      username: "",
      colorIndex: 0,
    });
    expect(buffer.samplesOf(1)).toHaveLength(1);
    expect(buffer.samplesOf(1)[0]).toMatchObject({ x: 1.5, y: 2.5, timeMs: 5_000 });
  });

  it("leaves unmodified chunks alone — their players persist across ticks", () => {
    const { deps, terrain, world, buffer } = makeTerrainFixture(() => 1_000);
    // Tick 1: deliver chunk (0,0) with one player.
    const tick1 = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [
          chunkWire(0, 0, [
            { id: 7, x: 4, y: 4, facing: anarchy.v1.Direction8.DIRECTION8_S },
          ]),
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick1, deps);
    expect(world.size()).toBe(1);

    // Tick 2: same chunk listed only as unmodified — no full-state.
    const tick2 = decodeRoundtrip({
      seq: 3,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [{ cx: 0, cy: 0 }],
      },
    });
    applyServerMessage(tick2, deps);

    // Player still in the world (chunk's player set didn't change).
    expect(world.size()).toBe(1);
    expect(world.getPlayer(7)).toBeDefined();
    expect(terrain.contains(0, 0)).toBe(true);
    // No new sample pushed for the unmodified chunk (would corrupt the
    // interpolation buffer if the position hasn't actually changed).
    expect(buffer.samplesOf(7)).toHaveLength(1);
  });

  it("implicitly unloads chunks not present in either list", () => {
    const { deps, terrain, world, onChunkUnloaded } = makeTerrainFixture();
    // Tick 1: load chunks (0,0) and (1,0), each with one player.
    const tick1 = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [
          chunkWire(0, 0, [
            { id: 1, x: 4, y: 4, facing: anarchy.v1.Direction8.DIRECTION8_S },
          ]),
          chunkWire(1, 0, [
            { id: 2, x: 20, y: 4, facing: anarchy.v1.Direction8.DIRECTION8_S },
          ]),
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick1, deps);
    expect(terrain.size()).toBe(2);
    expect(world.size()).toBe(2);

    // Tick 2: only (0,0) is in view; (1,0) is implicitly unloaded.
    const tick2 = decodeRoundtrip({
      seq: 3,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [{ cx: 0, cy: 0 }],
      },
    });
    applyServerMessage(tick2, deps);

    expect(terrain.contains(1, 0)).toBe(false);
    expect(terrain.contains(0, 0)).toBe(true);
    expect(world.getPlayer(2)).toBeUndefined();
    expect(world.getPlayer(1)).toBeDefined();
    expect(onChunkUnloaded).toContainEqual([1, 0]);
  });

  it("drops snapshot-buffer entries for players that fell out of view", () => {
    const { deps, buffer } = makeTerrainFixture();
    const tick1 = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [
          chunkWire(0, 0, [
            { id: 1, x: 4, y: 4, facing: anarchy.v1.Direction8.DIRECTION8_S },
          ]),
          chunkWire(1, 0, [
            { id: 2, x: 20, y: 4, facing: anarchy.v1.Direction8.DIRECTION8_S },
          ]),
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick1, deps);
    expect(buffer.knownIds().sort()).toEqual([1, 2]);

    const tick2 = decodeRoundtrip({
      seq: 3,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [{ cx: 0, cy: 0 }],
      },
    });
    applyServerMessage(tick2, deps);

    expect(buffer.knownIds()).toEqual([1]);
  });

  it("refresh of a full-state chunk overwrites prior content (server is canonical)", () => {
    const { deps, terrain, world } = makeTerrainFixture();
    const tick1 = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [
          chunkWire(0, 0, [
            { id: 1, x: 0, y: 0, facing: anarchy.v1.Direction8.DIRECTION8_E },
          ]),
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick1, deps);
    expect(world.getPlayer(1)?.x).toBe(0);

    // Tick 2: same chunk as full-state, player has moved east.
    const tick2 = decodeRoundtrip({
      seq: 3,
      tickUpdate: {
        fullStateChunks: [
          chunkWire(0, 0, [
            { id: 1, x: 5, y: 0, facing: anarchy.v1.Direction8.DIRECTION8_E },
          ]),
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick2, deps);

    expect(world.getPlayer(1)).toEqual({
      id: 1,
      x: 5,
      y: 0,
      facing: Direction8.E,
      username: "",
      colorIndex: 0,
    });
    expect(terrain.size()).toBe(1);
  });

  it("ignores malformed chunks (missing layer or wrong block count)", () => {
    const { deps, terrain } = makeTerrainFixture();
    const malformed: anarchy.v1.IChunk = {
      coord: { cx: 0, cy: 0 },
      ground: { blocks: [] }, // wrong length
      top: airLayerWire(),
      players: [],
    };
    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [malformed],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(msg, deps);

    expect(terrain.contains(0, 0)).toBe(false);
  });

  it("works without a Terrain reference (tests that don't exercise terrain)", () => {
    const { deps, world } = makeFixture();
    const wire = chunkWire(0, 0, [
      { id: 1, x: 1, y: 1, facing: anarchy.v1.Direction8.DIRECTION8_S },
    ]);
    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: { fullStateChunks: [wire], unmodifiedChunks: [] },
    });
    applyServerMessage(msg, deps);

    expect(world.getPlayer(1)).toEqual({
      id: 1,
      x: 1,
      y: 1,
      facing: Direction8.S,
      username: "",
      colorIndex: 0,
    });
  });

  it("decodes default facing (UNSPECIFIED → DEFAULT_FACING)", () => {
    const { deps, world } = makeFixture();
    const wire = chunkWire(0, 0, [{ id: 1, x: 0, y: 0 }]);
    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: { fullStateChunks: [wire], unmodifiedChunks: [] },
    });
    applyServerMessage(msg, deps);
    expect(world.getPlayer(1)?.facing).toBe(DEFAULT_FACING);
  });
});

