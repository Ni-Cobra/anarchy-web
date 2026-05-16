// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BlockType,
  DEFAULT_FACING,
  Inventory,
  MAX_PLAYER_HEALTH,
  World,
  type Player,
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
}

function buildRenderer(
  pick: MockPick | null,
): { renderer: Renderer; calls: MockRendererCalls } {
  const calls: MockRendererCalls = { pickCalls: [], setCursorCalls: [] };
  const renderer = {
    pickAtCursor: (ndc: { x: number; y: number }) => {
      calls.pickCalls.push({ x: ndc.x, y: ndc.y });
      return pick;
    },
    setCursorNdc: (ndc: { x: number; y: number } | null) => {
      calls.setCursorCalls.push(ndc === null ? null : { x: ndc.x, y: ndc.y });
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
