import { describe, expect, it } from "vitest";

import { anarchy } from "../gen/anarchy.js";
import {
  BlockType,
  DEFAULT_FACING,
  Direction8,
  EntityKind,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  LAYER_AREA,
  MAX_PLAYER_HEALTH,
  SnapshotBuffer,
  Terrain,
  World,
  emptyChunk,
  setBlock,
  type Chunk,
  type ChunkCoord,
  type PlayerId,
  type Slot,
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
      {
        id: 99,
        x: 5,
        y: 5,
        facing: DEFAULT_FACING,
        username: "",
        colorIndex: 0,
        equippedUtility: null,
        openChests: [],
        health: MAX_PLAYER_HEALTH,
        effects: [],
        xp: 0,
      },
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

  it("seeds the roster store from welcome.initialRoster (task 170)", async () => {
    const base = makeFixture();
    const { RosterStore } = await import("../game/index.js");
    const rosterStore = new RosterStore();
    const deps: WireDeps = { ...base.deps, rosterStore };

    const msg = decodeRoundtrip({
      seq: 1,
      welcome: {
        serverVersion: "test",
        tickRateHz: 20,
        playerId: 7,
        viewRadiusChunks: 2,
        initialRoster: {
          entries: [
            { playerId: 7, username: "You" },
            { playerId: 3, username: "Old" },
          ],
          maxPlayers: 32,
        },
      },
    });
    applyServerMessage(msg, deps);

    const r = rosterStore.current();
    expect(r).not.toBeNull();
    expect(r!.maxPlayers).toBe(32);
    expect(r!.entries.map((e) => e.playerId)).toEqual([7, 3]);
    expect(r!.entries.map((e) => e.username)).toEqual(["You", "Old"]);
  });
});

describe("applyServerMessage — ConnectedPlayersList (task 170)", () => {
  it("routes a top-level roster broadcast through to the roster store", async () => {
    const base = makeFixture();
    const { RosterStore } = await import("../game/index.js");
    const rosterStore = new RosterStore();
    const deps: WireDeps = { ...base.deps, rosterStore };

    const msg = decodeRoundtrip({
      seq: 2,
      connectedPlayersList: {
        entries: [
          { playerId: 1, username: "Alice" },
          { playerId: 2, username: "Bob" },
        ],
        maxPlayers: 16,
      },
    });
    applyServerMessage(msg, deps);

    const r = rosterStore.current();
    expect(r).not.toBeNull();
    expect(r!.maxPlayers).toBe(16);
    expect(r!.entries.map((e) => `${e.playerId}:${e.username}`)).toEqual([
      "1:Alice",
      "2:Bob",
    ]);
  });

  it("is a no-op when no rosterStore is wired (test/sub-feature paths)", () => {
    const { deps } = makeFixture();
    const msg = decodeRoundtrip({
      seq: 1,
      connectedPlayersList: { entries: [{ playerId: 1, username: "X" }], maxPlayers: 8 },
    });
    expect(() => applyServerMessage(msg, deps)).not.toThrow();
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
      equippedUtility: null,
      openChests: [],
      health: MAX_PLAYER_HEALTH,
      effects: [],
      xp: 0,
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

  it("populates chunk.entities from the wire and clears them on an empty refresh (task 010-entities)", () => {
    const { deps, terrain } = makeTerrainFixture();
    // Tick 1: chunk (0,0) carries two spiders.
    const tick1 = decodeRoundtrip({
      seq: 2,
      tickUpdate: {
        fullStateChunks: [
          {
            coord: { cx: 0, cy: 0 },
            ground: airLayerWire(),
            top: airLayerWire(),
            players: [],
            entities: [
              {
                id: 1,
                kind: anarchy.v1.EntityKind.ENTITY_KIND_SPIDER,
                tileX: 3,
                tileY: 4,
              },
              {
                id: 2,
                kind: anarchy.v1.EntityKind.ENTITY_KIND_SPIDER,
                tileX: 5,
                tileY: 6,
              },
            ],
          },
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick1, deps);
    const chunk1 = terrain.get(0, 0);
    expect(chunk1).toBeDefined();
    expect(chunk1?.entities.size).toBe(2);
    expect(chunk1?.entities.get(1)).toEqual({
      id: 1,
      kind: EntityKind.Spider,
      tileX: 3,
      tileY: 4,
      health: 20,
      effects: [],
    });
    expect(chunk1?.entities.get(2)).toEqual({
      id: 2,
      kind: EntityKind.Spider,
      tileX: 5,
      tileY: 6,
      health: 20,
      effects: [],
    });

    // Tick 2: same chunk with no entities — full-state apply must clear
    // the prior set (the server is canonical on entity membership).
    const tick2 = decodeRoundtrip({
      seq: 3,
      tickUpdate: {
        fullStateChunks: [
          {
            coord: { cx: 0, cy: 0 },
            ground: airLayerWire(),
            top: airLayerWire(),
            players: [],
            entities: [],
          },
        ],
        unmodifiedChunks: [],
      },
    });
    applyServerMessage(tick2, deps);
    const chunk2 = terrain.get(0, 0);
    expect(chunk2).toBeDefined();
    expect(chunk2?.entities.size).toBe(0);
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
      equippedUtility: null,
      openChests: [],
      health: MAX_PLAYER_HEALTH,
      effects: [],
      xp: 0,
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
      equippedUtility: null,
      openChests: [],
      health: MAX_PLAYER_HEALTH,
      effects: [],
      xp: 0,
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

  it("decodes the player's open-chest set from PlayerSnapshot (task 040)", () => {
    const { deps, world } = makeFixture();
    const wire = chunkWire(0, 0, [
      {
        id: 1,
        x: 0,
        y: 0,
        openChests: [
          { chunkCoord: { cx: 0, cy: 0 }, localX: 3, localY: 4 },
          { chunkCoord: { cx: -1, cy: 2 }, localX: 7, localY: 0 },
        ],
      },
    ]);
    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: { fullStateChunks: [wire], unmodifiedChunks: [] },
    });
    applyServerMessage(msg, deps);
    expect(world.getPlayer(1)?.openChests).toEqual([
      { cx: 0, cy: 0, lx: 3, ly: 4 },
      { cx: -1, cy: 2, lx: 7, ly: 0 },
    ]);
  });

  it("decodes an empty open-chest set as the empty array (task 040)", () => {
    const { deps, world } = makeFixture();
    const wire = chunkWire(0, 0, [{ id: 1, x: 0, y: 0 }]);
    const msg = decodeRoundtrip({
      seq: 2,
      tickUpdate: { fullStateChunks: [wire], unmodifiedChunks: [] },
    });
    applyServerMessage(msg, deps);
    expect(world.getPlayer(1)?.openChests).toEqual([]);
  });
});

describe("applyServerMessage — InventoryUpdate", () => {
  function makeInventoryFixture() {
    const base = makeFixture();
    const inventory = new Inventory();
    const deps: WireDeps = { ...base.deps, inventory };
    return { ...base, inventory, deps };
  }

  function buildWireSlots(
    overrides: Record<number, anarchy.v1.IItemSlot> = {},
  ): anarchy.v1.IItemSlot[] {
    const slots: anarchy.v1.IItemSlot[] = Array.from(
      { length: INVENTORY_SIZE },
      () => ({
        item: anarchy.v1.ItemId.ITEM_ID_UNSPECIFIED,
        count: 0,
      }),
    );
    for (const [k, v] of Object.entries(overrides)) {
      slots[Number(k)] = v;
    }
    return slots;
  }

  it("writes the slot array into the inventory mirror", () => {
    const { deps, inventory } = makeInventoryFixture();
    const wireSlots = buildWireSlots({
      0: { item: anarchy.v1.ItemId.ITEM_ID_GOLD, count: 10 },
    });
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: { slots: wireSlots },
    });
    applyServerMessage(msg, deps);
    expect(inventory.slot(0)).toEqual({ item: ItemId.Gold, count: 10 });
    expect(inventory.countOf(ItemId.Gold)).toBe(10);
  });

  it("translates every item kind to its game-side counterpart", () => {
    const { deps, inventory } = makeInventoryFixture();
    const wireSlots = buildWireSlots({
      0: { item: anarchy.v1.ItemId.ITEM_ID_STICK, count: 1 },
      1: { item: anarchy.v1.ItemId.ITEM_ID_WOOD, count: 2 },
      2: { item: anarchy.v1.ItemId.ITEM_ID_STONE, count: 3 },
      3: { item: anarchy.v1.ItemId.ITEM_ID_GOLD, count: 4 },
    });
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: { slots: wireSlots },
    });
    applyServerMessage(msg, deps);
    expect(inventory.slot(0)).toEqual({ item: ItemId.Stick, count: 1 });
    expect(inventory.slot(1)).toEqual({ item: ItemId.Wood, count: 2 });
    expect(inventory.slot(2)).toEqual({ item: ItemId.Stone, count: 3 });
    expect(inventory.slot(3)).toEqual({ item: ItemId.Gold, count: 4 });
  });

  it("translates every task-090 tool variant to its game-side counterpart", () => {
    const { deps, inventory } = makeInventoryFixture();
    const tools = [
      [anarchy.v1.ItemId.ITEM_ID_WOOD_PICKAXE, ItemId.WoodPickaxe],
      [anarchy.v1.ItemId.ITEM_ID_STONE_PICKAXE, ItemId.StonePickaxe],
      [anarchy.v1.ItemId.ITEM_ID_COPPER_PICKAXE, ItemId.CopperPickaxe],
      [anarchy.v1.ItemId.ITEM_ID_IRON_PICKAXE, ItemId.IronPickaxe],
      [anarchy.v1.ItemId.ITEM_ID_TUNGSTEN_PICKAXE, ItemId.TungstenPickaxe],
      [anarchy.v1.ItemId.ITEM_ID_WOOD_AXE, ItemId.WoodAxe],
      [anarchy.v1.ItemId.ITEM_ID_STONE_AXE, ItemId.StoneAxe],
      [anarchy.v1.ItemId.ITEM_ID_COPPER_AXE, ItemId.CopperAxe],
      [anarchy.v1.ItemId.ITEM_ID_IRON_AXE, ItemId.IronAxe],
      [anarchy.v1.ItemId.ITEM_ID_TUNGSTEN_AXE, ItemId.TungstenAxe],
    ] as const;
    const overrides: Record<number, anarchy.v1.IItemSlot> = {};
    for (let i = 0; i < tools.length; i++) {
      overrides[i] = { item: tools[i][0], count: 1 };
    }
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: { slots: buildWireSlots(overrides) },
    });
    applyServerMessage(msg, deps);
    for (let i = 0; i < tools.length; i++) {
      expect(inventory.slot(i)).toEqual({ item: tools[i][1], count: 1 });
    }
  });

  it("treats count=0 as the canonical empty regardless of item field", () => {
    const { deps, inventory } = makeInventoryFixture();
    const wireSlots = buildWireSlots({
      0: { item: anarchy.v1.ItemId.ITEM_ID_GOLD, count: 0 },
    });
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: { slots: wireSlots },
    });
    applyServerMessage(msg, deps);
    expect(inventory.slot(0)).toBeNull();
  });

  it("drops a frame whose slot count does not match INVENTORY_SIZE", () => {
    const { deps, inventory } = makeInventoryFixture();
    // Plant a known prior state so we can detect an erroneous overwrite.
    const known: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
    known[0] = { item: ItemId.Stone, count: 5 };
    inventory.replaceFromWire(known);

    const tooFew: anarchy.v1.IItemSlot[] = [
      { item: anarchy.v1.ItemId.ITEM_ID_GOLD, count: 1 },
    ];
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: { slots: tooFew },
    });
    applyServerMessage(msg, deps);
    // Inventory must remain unchanged.
    expect(inventory.slot(0)).toEqual({ item: ItemId.Stone, count: 5 });
  });

  it("is a no-op when no inventory mirror is supplied", () => {
    // Tests that don't exercise inventory should survive an InventoryUpdate
    // arriving without an `inventory` dep wired up.
    const { deps } = makeFixture();
    const wireSlots = buildWireSlots({
      0: { item: anarchy.v1.ItemId.ITEM_ID_GOLD, count: 10 },
    });
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: { slots: wireSlots },
    });
    expect(() => applyServerMessage(msg, deps)).not.toThrow();
  });

  it("forwards craftable_recipes onto the inventory mirror with availability", () => {
    // Task 100 wiring: every InventoryUpdate carries the per-player
    // advertised recipe list. The wire bridge stores it on the Inventory
    // mirror so the crafting panel can render rows (with affordability
    // tier) without a separate request frame.
    const { deps, inventory } = makeInventoryFixture();
    const wireSlots = buildWireSlots({
      0: { item: anarchy.v1.ItemId.ITEM_ID_WOOD, count: 5 },
    });
    const msg = decodeRoundtrip({
      seq: 2,
      inventoryUpdate: {
        slots: wireSlots,
        craftableRecipes: [
          { recipeId: "wood-pickaxe" },
          { recipeId: "sticks" },
          {
            recipeId: "torch",
            availability:
              anarchy.v1.RecipeAvailability.RECIPE_AVAILABILITY_PARTIAL_HINT,
          },
        ],
      },
    });
    applyServerMessage(msg, deps);
    // Affordable rows sort to the top lexically; partial-hint rows fall
    // to the bottom of the list.
    expect(inventory.getCraftableRecipes()).toEqual([
      { id: "sticks", availability: "affordable" },
      { id: "wood-pickaxe", availability: "affordable" },
      { id: "torch", availability: "partial-hint" },
    ]);
  });

  it("clears the craftable list when the field is absent / empty", () => {
    const { deps, inventory } = makeInventoryFixture();
    const slots = buildWireSlots({
      0: { item: anarchy.v1.ItemId.ITEM_ID_WOOD, count: 5 },
    });
    // Plant a non-empty list first so the absent-field overwrite is observable.
    applyServerMessage(
      decodeRoundtrip({
        seq: 2,
        inventoryUpdate: {
          slots,
          craftableRecipes: [{ recipeId: "sticks" }],
        },
      }),
      deps,
    );
    expect(inventory.getCraftableRecipes()).toEqual([
      { id: "sticks", availability: "affordable" },
    ]);

    applyServerMessage(
      decodeRoundtrip({
        seq: 3,
        inventoryUpdate: { slots: buildWireSlots() },
      }),
      deps,
    );
    expect(inventory.getCraftableRecipes()).toEqual([]);
  });
});

describe("applyServerMessage — TickUpdate effects feed (task 070)", () => {
  it("forwards block edits to the effects sink with the right shape", () => {
    const base = makeTerrainFixture();
    const edits: import("./wire.js").WireBlockEditEvent[] = [];
    const targetCalls: import("./wire.js").WireTargetingStateEvent[][] = [];
    const deps = {
      ...base.deps,
      effectsSink: {
        onBlockEdit: (e: import("./wire.js").WireBlockEditEvent) => edits.push(e),
        applyTargets: (
          ts: readonly import("./wire.js").WireTargetingStateEvent[],
        ) => targetCalls.push([...ts]),
      },
    };
    const msg = decodeRoundtrip({
      seq: 1,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [],
        edits: [
          {
            playerId: 17,
            kind: anarchy.v1.BlockEdit.Kind.BLOCK_EDIT_KIND_PLACED,
            chunkCoord: { cx: -1, cy: 2 },
            localX: 3,
            localY: 4,
            blockType: anarchy.v1.BlockType.BLOCK_TYPE_GOLD,
          },
          {
            playerId: 9,
            kind: anarchy.v1.BlockEdit.Kind.BLOCK_EDIT_KIND_BROKEN,
            chunkCoord: { cx: 5, cy: 6 },
            localX: 7,
            localY: 8,
            blockType: anarchy.v1.BlockType.BLOCK_TYPE_TREE,
          },
        ],
        targets: [],
      },
    });
    applyServerMessage(msg, deps);
    expect(edits).toEqual([
      {
        playerId: 17,
        kind: "placed",
        cx: -1,
        cy: 2,
        lx: 3,
        ly: 4,
        blockType: BlockType.Gold,
      },
      {
        playerId: 9,
        kind: "broken",
        cx: 5,
        cy: 6,
        lx: 7,
        ly: 8,
        blockType: BlockType.Tree,
      },
    ]);
    expect(targetCalls).toEqual([[]]);
  });

  it("forwards targeting states to the effects sink as a single replace call", () => {
    const base = makeTerrainFixture();
    const targetCalls: import("./wire.js").WireTargetingStateEvent[][] = [];
    const deps = {
      ...base.deps,
      effectsSink: {
        applyTargets: (
          ts: readonly import("./wire.js").WireTargetingStateEvent[],
        ) => targetCalls.push([...ts]),
      },
    };
    const msg = decodeRoundtrip({
      seq: 1,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [],
        edits: [],
        targets: [
          {
            playerId: 1,
            chunkCoord: { cx: 0, cy: 0 },
            localX: 5,
            localY: 6,
            durabilityPct: 75,
          },
        ],
      },
    });
    applyServerMessage(msg, deps);
    expect(targetCalls).toEqual([
      [{ playerId: 1, cx: 0, cy: 0, lx: 5, ly: 6, durabilityPct: 75 }],
    ]);
  });

  it("is a no-op when no effects sink is supplied", () => {
    const { deps } = makeTerrainFixture();
    const msg = decodeRoundtrip({
      seq: 1,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [],
        edits: [
          {
            playerId: 1,
            kind: anarchy.v1.BlockEdit.Kind.BLOCK_EDIT_KIND_PLACED,
            chunkCoord: { cx: 0, cy: 0 },
            localX: 0,
            localY: 0,
            blockType: anarchy.v1.BlockType.BLOCK_TYPE_GOLD,
          },
        ],
        targets: [
          {
            playerId: 1,
            chunkCoord: { cx: 0, cy: 0 },
            localX: 0,
            localY: 0,
            durabilityPct: 100,
          },
        ],
      },
    });
    expect(() => applyServerMessage(msg, deps)).not.toThrow();
  });

  it("forwards damage events to the effects sink (task 150)", () => {
    const base = makeTerrainFixture(() => 12_345);
    const observed: {
      events: import("./wire.js").WireDamageEvent[];
      tickReceivedMs: number;
    }[] = [];
    const deps = {
      ...base.deps,
      effectsSink: {
        onDamageEvents: (
          events: readonly import("./wire.js").WireDamageEvent[],
          tickReceivedMs: number,
        ) => observed.push({ events: [...events], tickReceivedMs }),
      },
    };
    const msg = decodeRoundtrip({
      seq: 1,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [],
        damageEvents: [
          {
            targetKind: anarchy.v1.TargetKind.TARGET_KIND_PLAYER,
            targetId: 2,
            amount: 15,
            attackerPlayerId: 1,
            happenedAtTick: 100,
          },
          {
            targetKind: anarchy.v1.TargetKind.TARGET_KIND_ENTITY,
            targetId: 42,
            amount: 5,
            attackerPlayerId: 0,
            happenedAtTick: 101,
          },
        ],
      },
    });
    applyServerMessage(msg, deps);
    expect(observed.length).toBe(1);
    expect(observed[0].tickReceivedMs).toBe(12_345);
    expect(observed[0].events).toEqual([
      {
        targetKind: "player",
        targetId: 2,
        amount: 15,
        attackerPlayerId: 1,
        happenedAtTick: 100,
      },
      {
        targetKind: "entity",
        targetId: 42,
        amount: 5,
        attackerPlayerId: 0,
        happenedAtTick: 101,
      },
    ]);
  });

  it("forwards attack events to the effects sink (task 070b)", () => {
    const base = makeTerrainFixture(() => 12_345);
    const observed: {
      events: import("./wire.js").WireAttackEvent[];
      tickReceivedMs: number;
    }[] = [];
    const deps = {
      ...base.deps,
      effectsSink: {
        onAttackEvents: (
          events: readonly import("./wire.js").WireAttackEvent[],
          tickReceivedMs: number,
        ) => observed.push({ events: [...events], tickReceivedMs }),
      },
    };
    const msg = decodeRoundtrip({
      seq: 1,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [],
        attackEvents: [
          {
            attackerPlayerId: 1,
            targetKind: anarchy.v1.TargetKind.TARGET_KIND_PLAYER,
            targetId: 2,
            outcome:
              anarchy.v1.AttackOutcome.ATTACK_OUTCOME_CHARGE_STARTED,
            startedAtTick: 100,
          },
          {
            attackerPlayerId: 3,
            targetKind: anarchy.v1.TargetKind.TARGET_KIND_ENTITY,
            targetId: 99,
            outcome:
              anarchy.v1.AttackOutcome.ATTACK_OUTCOME_STRIKE_HIT,
            startedAtTick: 200,
          },
          {
            attackerPlayerId: 4,
            targetKind: anarchy.v1.TargetKind.TARGET_KIND_PLAYER,
            targetId: 5,
            outcome:
              anarchy.v1.AttackOutcome
                .ATTACK_OUTCOME_STRIKE_MISSED_OUT_OF_REACH,
            startedAtTick: 300,
          },
        ],
      },
    });
    applyServerMessage(msg, deps);
    expect(observed.length).toBe(1);
    expect(observed[0].tickReceivedMs).toBe(12_345);
    expect(observed[0].events).toEqual([
      {
        attackerPlayerId: 1,
        targetKind: "player",
        targetId: 2,
        outcome: "charge-started",
        startedAtTick: 100,
      },
      {
        attackerPlayerId: 3,
        targetKind: "entity",
        targetId: 99,
        outcome: "strike-hit",
        startedAtTick: 200,
      },
      {
        attackerPlayerId: 4,
        targetKind: "player",
        targetId: 5,
        outcome: "strike-missed",
        startedAtTick: 300,
      },
    ]);
  });

  it("forwards death events to the effects sink (task 160)", () => {
    const base = makeTerrainFixture(() => 7_777);
    const observed: {
      events: import("./wire.js").WireDeathEvent[];
      tickReceivedMs: number;
    }[] = [];
    const deps = {
      ...base.deps,
      effectsSink: {
        onDeathEvents: (
          events: readonly import("./wire.js").WireDeathEvent[],
          tickReceivedMs: number,
        ) => observed.push({ events: [...events], tickReceivedMs }),
      },
    };
    const msg = decodeRoundtrip({
      seq: 1,
      tickUpdate: {
        fullStateChunks: [],
        unmodifiedChunks: [],
        deathEvents: [
          { playerId: 2, happenedAtTick: 100, killerPlayerId: 1 },
          { playerId: 5, happenedAtTick: 101, killerPlayerId: 0 },
        ],
      },
    });
    applyServerMessage(msg, deps);
    expect(observed.length).toBe(1);
    expect(observed[0].tickReceivedMs).toBe(7_777);
    expect(observed[0].events).toEqual([
      { playerId: 2, happenedAtTick: 100, killerPlayerId: 1 },
      { playerId: 5, happenedAtTick: 101, killerPlayerId: 0 },
    ]);
  });
});
