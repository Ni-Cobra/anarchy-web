import { REMOTE_RENDER_DELAY_MS } from "../config.js";
import type {
  SnapshotBuffer,
  World,
} from "../game/index.js";
import type { RenderableEntity } from "./sync.js";

/**
 * Compose the per-frame draw list. Per ADR 0003 every player — local and
 * remote — is rendered through `SnapshotBuffer` with the same
 * `REMOTE_RENDER_DELAY_MS` interpolation lag (prediction was removed
 * along with the chunk-centric refactor; see ADR 0003 §7).
 *
 * If a player has no sample yet (only possible immediately after spawn,
 * before the first sample push lands) we fall back to the latest
 * authoritative `World` position so the entity still appears on screen.
 */
export function composePlayerEntities(
  world: World,
  buffer: SnapshotBuffer,
  nowMs: number,
  remoteDelayMs: number = REMOTE_RENDER_DELAY_MS,
): RenderableEntity[] {
  const out: RenderableEntity[] = [];
  for (const player of world.players()) {
    const interp = buffer.sample(player.id, nowMs - remoteDelayMs);
    const pos = interp ?? { x: player.x, y: player.y };
    out.push({
      id: player.id,
      x: pos.x,
      y: pos.y,
      facing: player.facing,
      username: player.username,
      colorIndex: player.colorIndex,
    });
  }
  return out;
}
