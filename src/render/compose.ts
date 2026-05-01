import type { PlayerId, SnapshotBuffer, World } from "../game/index.js";
import type { RenderableEntity } from "./sync.js";

/**
 * Render-time delay applied to remote players. We draw remote spheres
 * ~100 ms behind real time and lerp between bracketing snapshots, so a
 * typical jitter or a single dropped tick never produces a visible jump.
 */
export const REMOTE_RENDER_DELAY_MS = 100;

/**
 * Render-time delay applied to the local player. One tick (50 ms at the
 * 20 Hz server cadence) — just enough that consecutive snapshots always
 * bracket the query and the player position interpolates smoothly between
 * them at the browser frame rate, while keeping the latency surfaced to
 * input as small as possible until full client-side prediction lands.
 */
export const LOCAL_RENDER_DELAY_MS = 50;

/**
 * Compose the per-frame draw list. Both local and remote players run
 * through the same `SnapshotBuffer` interpolation path; the only
 * difference is the render delay applied to each. If the buffer has no
 * sample for an id (only possible immediately after spawn, before the
 * first push lands), fall back to the latest authoritative position from
 * `world` so the player still appears on screen instead of vanishing.
 */
export function composePlayerEntities(
  world: World,
  buffer: SnapshotBuffer,
  localPlayerId: PlayerId | null,
  nowMs: number,
  localDelayMs: number = LOCAL_RENDER_DELAY_MS,
  remoteDelayMs: number = REMOTE_RENDER_DELAY_MS,
): RenderableEntity[] {
  const out: RenderableEntity[] = [];
  for (const player of world.players()) {
    const delay =
      player.id === localPlayerId ? localDelayMs : remoteDelayMs;
    const interp = buffer.sample(player.id, nowMs - delay);
    const pos = interp ?? { x: player.x, y: player.y };
    out.push({ id: player.id, x: pos.x, y: pos.y });
  }
  return out;
}
