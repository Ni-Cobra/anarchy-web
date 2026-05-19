// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BlockType,
  DEFAULT_FACING,
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  MAX_PLAYER_HEALTH,
  World,
  type Player,
  type Slot,
} from "../game/index.js";
import type { Renderer } from "../render/index.js";
import { attachBreakAndPlace, type BreakPlaceDeps } from "./break_place.js";

// Local structural alias for the renderer's `pickAtCursor` return shape.
// Avoids re-exporting `PickResult` from `render/index.ts` purely for a
// test stub — `attachBreakAndPlace` only consumes the structural fields
// `chunkCoord`, `localXY`, and `block.kind`.
interface MockPick {
  readonly chunkCoord: readonly [number, number];
  readonly localXY: readonly [number, number];
  readonly layer: "top" | "ground";
  readonly block: { readonly kind: BlockType };
}

// Task 555 regression: the held-break path must ship `BreakIntent` for
// every targetable cell — including ores whose `min_tool_tier` exceeds
// the player's equipped pickaxe. The pre-fix code refused to send a
// non-null target when `pick.gated` was true, so an empty-hand player
// clicking on IronOre never got the slow under-tooled break going (the
// server-side task 520 path was wired correctly but the wire intent
// never arrived). This pins that the gate has been removed from the
// outbound intent — the hint can still surface, but the swing always
// reaches the server.

const PLAYER_ID = 1;
const LOCAL_X = 0.5;
const LOCAL_Y = 0.5;

function buildPlayer(): Player {
  return {
    id: PLAYER_ID,
    x: LOCAL_X,
    y: LOCAL_Y,
    facing: DEFAULT_FACING,
    username: "tester",
    colorIndex: 0,
    equippedUtility: null,
    openChests: [],
    health: MAX_PLAYER_HEALTH,
    effects: [],
    xp: 0,
  };
}

function buildWorld(): World {
  const w = new World();
  w.applySnapshot([buildPlayer()]);
  return w;
}

interface MockRendererCalls {
  pickCalls: { x: number; y: number }[];
  setCursorCalls: ({ x: number; y: number } | null)[];
  attackPickCalls: { x: number; y: number }[];
}

function buildRenderer(
  pick: MockPick | null,
  attackPick:
    | { kind: "player"; id: number }
    | { kind: "entity"; id: number }
    | null = null,
): { renderer: Renderer; calls: MockRendererCalls } {
  const calls: MockRendererCalls = {
    pickCalls: [],
    setCursorCalls: [],
    attackPickCalls: [],
  };
  const renderer = {
    pickAtCursor: (ndc: { x: number; y: number }) => {
      calls.pickCalls.push({ x: ndc.x, y: ndc.y });
      return pick;
    },
    setCursorNdc: (ndc: { x: number; y: number } | null) => {
      calls.setCursorCalls.push(ndc === null ? null : { x: ndc.x, y: ndc.y });
    },
    pickAttackTargetAtCursor: (ndc: { x: number; y: number }) => {
      calls.attackPickCalls.push({ x: ndc.x, y: ndc.y });
      return attackPick;
    },
  };
  return { renderer: renderer as unknown as Renderer, calls };
}

function buildDeps(
  pick: MockPick | null,
  sendBreakIntent: BreakPlaceDeps["sendBreakIntent"],
  sendPlaceBlock: BreakPlaceDeps["sendPlaceBlock"] = vi.fn(),
): { deps: BreakPlaceDeps; rendererCalls: MockRendererCalls } {
  const { renderer, calls } = buildRenderer(pick);
  return {
    deps: {
      world: buildWorld(),
      renderer,
      getLocalPlayerId: () => PLAYER_ID,
      getInventory: () => new Inventory(),
      sendBreakIntent,
      sendPlaceBlock,
    },
    rendererCalls: calls,
  };
}

function tilePickAt(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kind: BlockType,
): MockPick {
  return {
    chunkCoord: [cx, cy],
    localXY: [lx, ly],
    layer: "top",
    block: { kind },
  };
}

function fireMouseDown(button: number, clientX: number, clientY: number): void {
  window.dispatchEvent(
    new MouseEvent("mousedown", {
      button,
      clientX,
      clientY,
      bubbles: true,
    }),
  );
}

function fireMouseUp(button: number, clientX: number, clientY: number): void {
  window.dispatchEvent(
    new MouseEvent("mouseup", {
      button,
      clientX,
      clientY,
      bubbles: true,
    }),
  );
}

describe("attachBreakAndPlace — task 555 empty-hand gate", () => {
  let detach: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    // happy-dom doesn't size window for us; pin a viewport so the
    // clientX/Y → NDC math in break_place.ts is deterministic.
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  });

  afterEach(() => {
    if (detach) detach();
    detach = null;
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("ships a non-null BreakIntent for a gated ore cell (IronOre + empty hand)", () => {
    // The cell is in reach (tile center (1.5, 0.5) is 1 unit from the
    // player at (0.5, 0.5); REACH_BLOCKS = 4) and the player has no
    // equipped pickaxe, so `pickBreakTargetAt` flags it `gated`. The
    // fix is that the intent ships anyway — the server's task 520 slow
    // path handles the rest.
    const sendBreakIntent = vi.fn();
    const { deps } = buildDeps(
      tilePickAt(0, 0, 1, 0, BlockType.IronOre),
      sendBreakIntent,
    );
    detach = attachBreakAndPlace(window, deps);

    fireMouseDown(0, 400, 300);

    expect(sendBreakIntent).toHaveBeenCalledTimes(1);
    expect(sendBreakIntent).toHaveBeenLastCalledWith({
      cx: 0,
      cy: 0,
      lx: 1,
      ly: 0,
    });
  });

  it("releases the held break on mouseup even after a gated start", () => {
    const sendBreakIntent = vi.fn();
    const { deps } = buildDeps(
      tilePickAt(0, 0, 1, 0, BlockType.CopperOre),
      sendBreakIntent,
    );
    detach = attachBreakAndPlace(window, deps);

    fireMouseDown(0, 400, 300);
    fireMouseUp(0, 400, 300);

    expect(sendBreakIntent.mock.calls).toEqual([
      [{ cx: 0, cy: 0, lx: 1, ly: 0 }],
      [null],
    ]);
  });

  it("still ships the intent for non-gated cells (regression guard for Stone)", () => {
    const sendBreakIntent = vi.fn();
    const { deps } = buildDeps(
      tilePickAt(0, 0, 1, 0, BlockType.Stone),
      sendBreakIntent,
    );
    detach = attachBreakAndPlace(window, deps);

    fireMouseDown(0, 400, 300);

    expect(sendBreakIntent).toHaveBeenCalledTimes(1);
    expect(sendBreakIntent).toHaveBeenLastCalledWith({
      cx: 0,
      cy: 0,
      lx: 1,
      ly: 0,
    });
  });

  it("ships null when the picker returns null (no cell under cursor)", () => {
    const sendBreakIntent = vi.fn();
    const { deps } = buildDeps(null, sendBreakIntent);
    detach = attachBreakAndPlace(window, deps);

    fireMouseDown(0, 400, 300);

    expect(sendBreakIntent).toHaveBeenCalledTimes(1);
    expect(sendBreakIntent).toHaveBeenLastCalledWith(null);
  });
});

describe("attachBreakAndPlace — task 070b target-pick", () => {
  let detach: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  });

  afterEach(() => {
    if (detach) detach();
    detach = null;
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  function buildAttackDeps(opts: {
    attackPick:
      | { kind: "player"; id: number }
      | { kind: "entity"; id: number }
      | null;
    targetPos: { x: number; y: number } | null;
    sendAttackIntent: BreakPlaceDeps["sendAttackIntent"];
    sendBreakIntent?: BreakPlaceDeps["sendBreakIntent"];
  }): BreakPlaceDeps {
    const { renderer } = buildRenderer(null, opts.attackPick);
    return {
      world: buildWorld(),
      renderer,
      getLocalPlayerId: () => PLAYER_ID,
      getInventory: () => new Inventory(),
      sendBreakIntent: opts.sendBreakIntent ?? vi.fn(),
      sendPlaceBlock: vi.fn(),
      sendAttackIntent: opts.sendAttackIntent,
      getAttackTargetPosition: () => opts.targetPos,
    };
  }

  it("ships AttackIntent for a player target in range (not BreakIntent)", () => {
    const sendAttackIntent = vi.fn();
    const sendBreakIntent = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildAttackDeps({
        attackPick: { kind: "player", id: 99 },
        // Player at (2.5, 0.5) is ~2 tiles from local (0.5, 0.5) — well
        // inside the 6-tile ATTACK_RANGE.
        targetPos: { x: 2.5, y: 0.5 },
        sendAttackIntent,
        sendBreakIntent,
      }),
    );

    fireMouseDown(0, 400, 300);

    expect(sendAttackIntent).toHaveBeenCalledTimes(1);
    expect(sendAttackIntent).toHaveBeenCalledWith("player", 99);
    expect(sendBreakIntent).not.toHaveBeenCalled();
  });

  it("admits a target at 5.5 tiles (would have rejected pre-110)", () => {
    // Task 110 bumped ATTACK_RANGE_TILES 4 → 6. A target 5.5 tiles east
    // would have rejected under the old gate but admits now.
    const sendAttackIntent = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildAttackDeps({
        attackPick: { kind: "player", id: 99 },
        targetPos: { x: 6.0, y: 0.5 },
        sendAttackIntent,
      }),
    );

    fireMouseDown(0, 400, 300);

    expect(sendAttackIntent).toHaveBeenCalledTimes(1);
    expect(sendAttackIntent).toHaveBeenCalledWith("player", 99);
  });

  it("ships AttackIntent for an entity target in range", () => {
    const sendAttackIntent = vi.fn();
    const sendBreakIntent = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildAttackDeps({
        attackPick: { kind: "entity", id: 42 },
        targetPos: { x: 1.5, y: 1.5 },
        sendAttackIntent,
        sendBreakIntent,
      }),
    );

    fireMouseDown(0, 400, 300);

    expect(sendAttackIntent).toHaveBeenCalledTimes(1);
    expect(sendAttackIntent).toHaveBeenCalledWith("entity", 42);
    expect(sendBreakIntent).not.toHaveBeenCalled();
  });

  it("suppresses AttackIntent when the target is beyond ATTACK_RANGE_TILES", () => {
    const sendAttackIntent = vi.fn();
    const sendBreakIntent = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildAttackDeps({
        attackPick: { kind: "player", id: 99 },
        // ~30 tiles east — far beyond the 6-tile range gate.
        targetPos: { x: 30.5, y: 0.5 },
        sendAttackIntent,
        sendBreakIntent,
      }),
    );

    fireMouseDown(0, 400, 300);

    expect(sendAttackIntent).not.toHaveBeenCalled();
    // Out-of-range click also suppresses the held-break so the user's
    // intent (attack) isn't misinterpreted as a swing at the air.
    expect(sendBreakIntent).not.toHaveBeenCalled();
  });

  it("falls through to BreakIntent when no target is under the cursor", () => {
    const sendAttackIntent = vi.fn();
    const sendBreakIntent = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildAttackDeps({
        attackPick: null,
        targetPos: null,
        sendAttackIntent,
        sendBreakIntent,
      }),
    );

    fireMouseDown(0, 400, 300);

    expect(sendAttackIntent).not.toHaveBeenCalled();
    // BreakIntent ships with `null` because the test renderer's
    // pickAtCursor returns null (no block under cursor).
    expect(sendBreakIntent).toHaveBeenCalledTimes(1);
    expect(sendBreakIntent).toHaveBeenLastCalledWith(null);
  });
});

describe("attachBreakAndPlace — task 200c blowgun routing", () => {
  let detach: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  });

  afterEach(() => {
    if (detach) detach();
    detach = null;
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  function inventoryWithBlowgunAndDarts(darts: number): Inventory {
    const inv = new Inventory();
    const slots: Slot[] = new Array(INVENTORY_SIZE).fill(null);
    slots[0] = { item: ItemId.Blowgun, count: 1 };
    if (darts > 0) {
      slots[1] = { item: ItemId.PoisonDart, count: darts };
    }
    inv.replaceFromWire(slots, null, null, [], 0, null, null);
    return inv;
  }

  function inventoryNoBlowgun(): Inventory {
    const inv = new Inventory();
    inv.replaceFromWire(new Array(INVENTORY_SIZE).fill(null) as Slot[]);
    return inv;
  }

  function buildBlowgunDeps(opts: {
    attackPick: { kind: "player"; id: number } | { kind: "entity"; id: number } | null;
    targetPos: { x: number; y: number } | null;
    inventory: Inventory;
    sendFireBlowgunIntent: BreakPlaceDeps["sendFireBlowgunIntent"];
    sendPlaceBlock?: BreakPlaceDeps["sendPlaceBlock"];
    nowMs?: () => number;
    onBlowgunFireDispatched?: (nowMs: number) => void;
    pick?: MockPick | null;
  }): BreakPlaceDeps {
    const { renderer } = buildRenderer(opts.pick ?? null, opts.attackPick);
    return {
      world: buildWorld(),
      renderer,
      getLocalPlayerId: () => PLAYER_ID,
      getInventory: () => opts.inventory,
      sendBreakIntent: vi.fn(),
      sendPlaceBlock: opts.sendPlaceBlock ?? vi.fn(),
      sendFireBlowgunIntent: opts.sendFireBlowgunIntent,
      getAttackTargetPosition: () => opts.targetPos,
      onBlowgunFireDispatched: opts.onBlowgunFireDispatched,
      nowMs: opts.nowMs,
    };
  }

  function fireRightClick(clientX: number, clientY: number): void {
    fireMouseDown(2, clientX, clientY);
  }

  it("ships FireBlowgunIntent on right-click against a player in range", () => {
    const sendFire = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: { kind: "player", id: 99 },
        targetPos: { x: 4.5, y: 0.5 },
        inventory: inventoryWithBlowgunAndDarts(5),
        sendFireBlowgunIntent: sendFire,
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).toHaveBeenCalledTimes(1);
    expect(sendFire).toHaveBeenCalledWith("player", 99);
  });

  it("ships FireBlowgunIntent on right-click against an entity in range", () => {
    const sendFire = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: { kind: "entity", id: 42 },
        targetPos: { x: 1.5, y: 1.5 },
        inventory: inventoryWithBlowgunAndDarts(2),
        sendFireBlowgunIntent: sendFire,
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).toHaveBeenCalledTimes(1);
    expect(sendFire).toHaveBeenCalledWith("entity", 42);
  });

  it("does NOT send PlaceBlock on right-click on a block while blowgun is equipped", () => {
    const sendFire = vi.fn();
    const sendPlace = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: null,
        targetPos: null,
        inventory: inventoryWithBlowgunAndDarts(3),
        sendFireBlowgunIntent: sendFire,
        sendPlaceBlock: sendPlace,
        pick: tilePickAt(0, 0, 1, 0, BlockType.Air),
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).not.toHaveBeenCalled();
    expect(sendPlace).not.toHaveBeenCalled();
  });

  it("does not fire when no dart is in inventory", () => {
    const sendFire = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: { kind: "player", id: 99 },
        targetPos: { x: 4.5, y: 0.5 },
        inventory: inventoryWithBlowgunAndDarts(0),
        sendFireBlowgunIntent: sendFire,
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).not.toHaveBeenCalled();
  });

  it("does not fire when target is beyond BLOWGUN_RANGE_TILES", () => {
    const sendFire = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: { kind: "player", id: 99 },
        targetPos: { x: 12.5, y: 0.5 },
        inventory: inventoryWithBlowgunAndDarts(5),
        sendFireBlowgunIntent: sendFire,
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).not.toHaveBeenCalled();
  });

  it("local cooldown gate suppresses a second fire inside 1 s", () => {
    const sendFire = vi.fn();
    let nowMs = 1_000_000;
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: { kind: "player", id: 99 },
        targetPos: { x: 4.5, y: 0.5 },
        inventory: inventoryWithBlowgunAndDarts(5),
        sendFireBlowgunIntent: sendFire,
        nowMs: () => nowMs,
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).toHaveBeenCalledTimes(1);

    nowMs += 500;
    fireRightClick(400, 300);
    expect(sendFire).toHaveBeenCalledTimes(1);

    nowMs += 600;
    fireRightClick(400, 300);
    expect(sendFire).toHaveBeenCalledTimes(2);
  });

  it("notifies the session of dispatched fires via onBlowgunFireDispatched", () => {
    const sendFire = vi.fn();
    const onDispatched = vi.fn();
    let nowMs = 50_000;
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: { kind: "player", id: 99 },
        targetPos: { x: 4.5, y: 0.5 },
        inventory: inventoryWithBlowgunAndDarts(5),
        sendFireBlowgunIntent: sendFire,
        onBlowgunFireDispatched: onDispatched,
        nowMs: () => nowMs,
      }),
    );
    fireRightClick(400, 300);
    expect(onDispatched).toHaveBeenCalledTimes(1);
    expect(onDispatched).toHaveBeenCalledWith(50_000);
  });

  it("does not run the blowgun path when no blowgun is equipped", () => {
    const sendFire = vi.fn();
    const sendPlace = vi.fn();
    detach = attachBreakAndPlace(
      window,
      buildBlowgunDeps({
        attackPick: null,
        targetPos: null,
        inventory: inventoryNoBlowgun(),
        sendFireBlowgunIntent: sendFire,
        sendPlaceBlock: sendPlace,
        pick: tilePickAt(0, 0, 1, 0, BlockType.Air),
      }),
    );
    fireRightClick(400, 300);
    expect(sendFire).not.toHaveBeenCalled();
    expect(sendPlace).toHaveBeenCalledTimes(1);
  });

  it("hotbar slot count is the standard 9", () => {
    expect(HOTBAR_SLOTS).toBe(9);
  });
});
