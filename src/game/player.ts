/**
 * `Player` — the entity carried by `World`.
 *
 * Mirrors the server's `game::Player` (id + continuous world position +
 * 8-way facing). World coords follow the same convention: `+y = north`,
 * `+x = east`. Positions are floats — the wire format carries `double`
 * x/y, and movement advances by sub-tile amounts as movement intent and
 * tick stepping land.
 *
 * `facing` mirrors the server's sticky 8-way direction: the server snaps
 * it to the nearest of 8 each tick movement intent is non-zero and leaves
 * it alone otherwise. Clients render from this — they never compute or
 * predict it locally.
 */
import type { ItemId } from "./inventory.js";

export type PlayerId = number;

/**
 * 8-way facing in clockwise order from north. Mirrors the server's
 * `game::Direction8` and the proto `Direction8` enum (the client uses the
 * same numeric values as the wire so a snapshot's `facing` int can be cast
 * directly).
 */
export enum Direction8 {
  N = 1,
  NE = 2,
  E = 3,
  SE = 4,
  S = 5,
  SW = 6,
  W = 7,
  NW = 8,
}

/** Default facing for a freshly-spawned player. */
export const DEFAULT_FACING: Direction8 = Direction8.S;

export interface Player {
  readonly id: PlayerId;
  x: number;
  y: number;
  facing: Direction8;
  /**
   * Per-session display name from the player's lobby submit. Already
   * trimmed + validated server-side (see `anarchy-server/src/game/
   * lobby.rs`), so the client renders it directly. Empty string only on
   * placeholder snapshots that predate admission — production never emits
   * an empty username.
   */
  username: string;
  /**
   * Index into `PALETTE` (see `./palette.ts`). The renderer tints the
   * player body by this entry. Defaults to `0` if the wire field is
   * missing (forwards-compat against an older server, though the schemas
   * are synced today).
   */
  colorIndex: number;
  /**
   * Item the server reports equipped in this player's Utility slot, or
   * `null` when nothing is. Visible to every observer (carried on
   * `PlayerSnapshot`, not the per-client `InventoryUpdate`) so the
   * lantern's player-attached point light renders for remote players too.
   * Today only [`ItemId.Lantern`] flows through this path.
   */
  equippedUtility: ItemId | null;
  /**
   * Chests this player currently has open (task 590 multi-open). Carried
   * on `PlayerSnapshot` so every observer sees the set, not just the
   * originating client — the renderer draws a light beam from each
   * player to each chest they have open. Empty when nothing is open.
   */
  openChests: readonly OpenChestRef[];
  /**
   * Current HP (task 060). `0` means dead; `MAX_PLAYER_HEALTH` is full.
   * The local player's HP feeds the bottom-of-screen HP bar; remote
   * players' HP is on the wire too but is not rendered this iteration.
   * Defaults to `MAX_PLAYER_HEALTH` when the wire field is unset (older
   * server snapshots pre-task 060).
   */
  health: number;
}

/**
 * Hard cap on player HP — mirrors the server's `MAX_PLAYER_HEALTH`. Pinned
 * client-side so the HP bar can compute its fill fraction without an extra
 * wire field. Bump in lockstep with the server constant in
 * `anarchy-server/src/game/player/health.rs`.
 */
export const MAX_PLAYER_HEALTH = 100;

/**
 * One chest the player currently has open. Block-coord form
 * (chunk + local cell) so the renderer can resolve a world position
 * via `tileCenterToScene` without inflating it into a higher-level
 * `ChestLocation` (that lives in `chest_state.ts`).
 */
export interface OpenChestRef {
  readonly cx: number;
  readonly cy: number;
  readonly lx: number;
  readonly ly: number;
}
