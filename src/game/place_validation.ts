import { PLAYER_RADIUS, REACH_BLOCKS } from "../config.js";
import type { PlayerId } from "./player.js";
import { BlockType, CHUNK_SIZE, type Terrain } from "./terrain.js";
import type { World } from "./world.js";

/**
 * Mirror of `World::try_place_top_block`'s pre-validation, run client-side
 * so the UI never invites a click the server will silently drop. Three
 * gates: target tile's top layer is empty, target is within `REACH_BLOCKS`
 * of the local player's center, and no player's collision circle overlaps
 * the cell. The strict-less circle-vs-cell overlap matches the server's
 * check, including the "tangent against the cell" exception.
 *
 * The duplication across the wire is the one allowed redundancy per the
 * project charter — anything wire-shaped or validation-shaped must agree
 * on both sides. Keep this file in lockstep with the server's validator.
 */
export function canPlaceTopBlock(
  world: World,
  terrain: Terrain,
  localPlayerId: PlayerId | null,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
): boolean {
  if (localPlayerId === null) return false;
  const me = world.getPlayer(localPlayerId);
  if (!me) return false;
  const chunk = terrain.get(cx, cy);
  if (!chunk) return false;
  const top = chunk.top.blocks[ly * CHUNK_SIZE + lx];
  if (!top || top.kind !== BlockType.Air) return false;
  const tileX = cx * CHUNK_SIZE + lx;
  const tileY = cy * CHUNK_SIZE + ly;
  const tileCenterX = tileX + 0.5;
  const tileCenterY = tileY + 0.5;
  const dx = tileCenterX - me.x;
  const dy = tileCenterY - me.y;
  if (dx * dx + dy * dy > REACH_BLOCKS * REACH_BLOCKS) return false;
  const r2 = PLAYER_RADIUS * PLAYER_RADIUS;
  for (const p of world.players()) {
    const nx = clamp(p.x, tileX, tileX + 1);
    const ny = clamp(p.y, tileY, tileY + 1);
    const ddx = p.x - nx;
    const ddy = p.y - ny;
    if (ddx * ddx + ddy * ddy < r2) return false;
  }
  return true;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
