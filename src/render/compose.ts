import type {
  LocalPredictor,
  PlayerId,
  SnapshotBuffer,
  World,
} from "../game/index.js";
import type { RenderableEntity } from "./sync.js";

/**
 * Render-time delay applied to remote players. We draw remote players
 * ~100 ms behind real time and lerp between bracketing snapshots, so a
 * typical jitter or a single dropped tick never produces a visible jump.
 */
export const REMOTE_RENDER_DELAY_MS = 100;

/**
 * Compose the per-frame draw list. Remote players run through the
 * `SnapshotBuffer` interpolation path with `REMOTE_RENDER_DELAY_MS` of
 * lag; the local player is drawn at the predictor's current position so
 * input lands on the next frame instead of after a WebSocket round-trip.
 *
 * If a remote player has no sample yet (only possible immediately after
 * spawn, before the first snapshot push lands) we fall back to the latest
 * authoritative `World` position so the entity still appears on screen.
 * If `predictor` is null the local player renders from the snapshot buffer
 * just like remote players — the wire layer hands a non-null predictor in
 * once `ServerWelcome` has assigned a local player id.
 */
export function composePlayerEntities(
  world: World,
  buffer: SnapshotBuffer,
  localPlayerId: PlayerId | null,
  predictor: LocalPredictor | null,
  nowMs: number,
  remoteDelayMs: number = REMOTE_RENDER_DELAY_MS,
): RenderableEntity[] {
  const out: RenderableEntity[] = [];
  for (const player of world.players()) {
    if (player.id === localPlayerId && predictor !== null) {
      const pos = predictor.position(nowMs);
      out.push({ id: player.id, x: pos.x, y: pos.y });
      continue;
    }
    const interp = buffer.sample(player.id, nowMs - remoteDelayMs);
    const pos = interp ?? { x: player.x, y: player.y };
    out.push({ id: player.id, x: pos.x, y: pos.y });
  }
  return out;
}
