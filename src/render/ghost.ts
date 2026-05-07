/**
 * Ghost-block preview driver. Given the player's currently selected hotbar
 * slot and a cursor pick, decides whether to show a translucent preview at
 * the cell the player is about to right-click-place — and which kind of
 * block the preview should depict.
 *
 * Pure logic, separated from `renderer.ts` so it can be unit-tested without
 * a Three.js context. The renderer's per-frame loop calls
 * `computeGhostState` and hands the result to its private mesh painter.
 *
 * The kind-detection branch (placeable vs. tool vs. empty) mirrors the
 * server's `ItemId::metadata().places_block` mapping in
 * `anarchy-server/src/game/item/mod.rs`. This is the second of the two
 * allowed cross-wire duplications (alongside `place_validation.ts`) — keep
 * `placeableBlockForItem` in lockstep with the server registry as new
 * items are added.
 */

import {
  BlockType,
  ItemId,
  type PlayerId,
  type Slot,
  type Terrain,
  type World,
  canPlaceTopBlock,
} from "../game/index.js";
import type { PickResult } from "./picker.js";

export interface GhostState {
  readonly cell: readonly [number, number, number, number];
  readonly kind: BlockType;
}

/**
 * Block kind that placing this item would produce, or `null` for items
 * that don't place a block (future tools, crafting-only items). Mirrors
 * the server's `places_block` field exactly.
 */
export function placeableBlockForItem(item: ItemId): BlockType | null {
  switch (item) {
    case ItemId.Stick:
      return BlockType.Sticks;
    case ItemId.Wood:
      return BlockType.Wood;
    case ItemId.Stone:
      return BlockType.Stone;
    case ItemId.Gold:
      return BlockType.Gold;
  }
  return null;
}

/** Convenience over `placeableBlockForItem` for an inventory `Slot`. */
export function placeableBlockForSlot(slot: Slot): BlockType | null {
  if (slot === null) return null;
  return placeableBlockForItem(slot.item);
}

/**
 * Decide whether the ghost preview should be visible this frame, and at
 * which cell + kind. Returns `null` when any of:
 *   - The held slot is empty or holds a non-placeable item (tool).
 *   - The cursor isn't over a loaded chunk.
 *   - The picked layer is `top` (target cell already occupied at the top).
 *   - The server-mirrored place validator would reject the cell (out of
 *     reach, top-layer non-Air, or overlaps a player AABB).
 */
export function computeGhostState(args: {
  readonly slot: Slot;
  readonly pick: PickResult | null;
  readonly world: World;
  readonly terrain: Terrain;
  readonly localPlayerId: PlayerId | null;
}): GhostState | null {
  const kind = placeableBlockForSlot(args.slot);
  if (kind === null) return null;
  if (args.pick === null) return null;
  const [cx, cy] = args.pick.chunkCoord;
  const [lx, ly] = args.pick.localXY;
  if (
    !canPlaceTopBlock(args.world, args.terrain, args.localPlayerId, cx, cy, lx, ly)
  ) {
    return null;
  }
  return { cell: [cx, cy, lx, ly], kind };
}
