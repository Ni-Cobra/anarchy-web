/**
 * Shared wire-decode primitives for the `net/` bridge.
 *
 * Per-message-kind handlers (`wire_tick.ts`, `wire_inventory.ts`) lean on
 * these to translate small enum / scalar fields without each file
 * reinventing the per-variant `switch`. Kept side-effect-free and
 * dependency-light so the handlers stay readable.
 *
 * Module-boundary rule: lives in `net/` because it imports
 * `../gen/anarchy.js`. Nothing outside `net/` should import this module.
 */
import { anarchy } from "../gen/anarchy.js";
import {
  BlockType,
  DEFAULT_FACING,
  Direction8,
} from "../game/index.js";

/**
 * `protobufjs` represents 64-bit fields as either a JS `number` (when the
 * value fits) or a `Long`-like object exposing `.toNumber()`. The wire
 * bridge always deals in JS numbers (player ids fit comfortably), so we
 * normalise at the boundary.
 */
export function toNumber(
  v: number | { toNumber(): number } | null | undefined,
): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return v.toNumber();
}

/** Stable string key for `(cx, cy)` — used by chunk-window set membership. */
export function coordKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function blockTypeFromWire(
  kind: anarchy.v1.BlockType | null | undefined,
): BlockType {
  switch (kind) {
    case anarchy.v1.BlockType.BLOCK_TYPE_GRASS:
      return BlockType.Grass;
    case anarchy.v1.BlockType.BLOCK_TYPE_WOOD:
      return BlockType.Wood;
    case anarchy.v1.BlockType.BLOCK_TYPE_STONE:
      return BlockType.Stone;
    case anarchy.v1.BlockType.BLOCK_TYPE_GOLD:
      return BlockType.Gold;
    case anarchy.v1.BlockType.BLOCK_TYPE_TREE:
      return BlockType.Tree;
    case anarchy.v1.BlockType.BLOCK_TYPE_STICKS:
      return BlockType.Sticks;
    case anarchy.v1.BlockType.BLOCK_TYPE_HIDDEN:
      return BlockType.Hidden;
    case anarchy.v1.BlockType.BLOCK_TYPE_FLOWER_RED:
      return BlockType.FlowerRed;
    case anarchy.v1.BlockType.BLOCK_TYPE_FLOWER_YELLOW:
      return BlockType.FlowerYellow;
    case anarchy.v1.BlockType.BLOCK_TYPE_FLOWER_BLUE:
      return BlockType.FlowerBlue;
    case anarchy.v1.BlockType.BLOCK_TYPE_FLOWER_WHITE:
      return BlockType.FlowerWhite;
    case anarchy.v1.BlockType.BLOCK_TYPE_BUSH:
      return BlockType.Bush;
    case anarchy.v1.BlockType.BLOCK_TYPE_DIRT:
      return BlockType.Dirt;
    case anarchy.v1.BlockType.BLOCK_TYPE_SAND:
      return BlockType.Sand;
    case anarchy.v1.BlockType.BLOCK_TYPE_GRAVEL:
      return BlockType.Gravel;
    case anarchy.v1.BlockType.BLOCK_TYPE_STONE_LIGHT:
      return BlockType.StoneLight;
    case anarchy.v1.BlockType.BLOCK_TYPE_STONE_DARK:
      return BlockType.StoneDark;
    case anarchy.v1.BlockType.BLOCK_TYPE_COPPER_ORE:
      return BlockType.CopperOre;
    case anarchy.v1.BlockType.BLOCK_TYPE_IRON_ORE:
      return BlockType.IronOre;
    case anarchy.v1.BlockType.BLOCK_TYPE_TUNGSTEN_ORE:
      return BlockType.TungstenOre;
    case anarchy.v1.BlockType.BLOCK_TYPE_COAL_ORE:
      return BlockType.CoalOre;
    case anarchy.v1.BlockType.BLOCK_TYPE_DIAMOND_ORE:
      return BlockType.DiamondOre;
    case anarchy.v1.BlockType.BLOCK_TYPE_TORCH:
      return BlockType.Torch;
    case anarchy.v1.BlockType.BLOCK_TYPE_CHEST:
      return BlockType.Chest;
    case anarchy.v1.BlockType.BLOCK_TYPE_TOMBSTONE:
      return BlockType.Tombstone;
    case anarchy.v1.BlockType.BLOCK_TYPE_AIR:
    default:
      return BlockType.Air;
  }
}

export function facingFromWire(
  facing: anarchy.v1.Direction8 | null | undefined,
): Direction8 {
  switch (facing) {
    case anarchy.v1.Direction8.DIRECTION8_N:
      return Direction8.N;
    case anarchy.v1.Direction8.DIRECTION8_NE:
      return Direction8.NE;
    case anarchy.v1.Direction8.DIRECTION8_E:
      return Direction8.E;
    case anarchy.v1.Direction8.DIRECTION8_SE:
      return Direction8.SE;
    case anarchy.v1.Direction8.DIRECTION8_S:
      return Direction8.S;
    case anarchy.v1.Direction8.DIRECTION8_SW:
      return Direction8.SW;
    case anarchy.v1.Direction8.DIRECTION8_W:
      return Direction8.W;
    case anarchy.v1.Direction8.DIRECTION8_NW:
      return Direction8.NW;
    default:
      return DEFAULT_FACING;
  }
}
