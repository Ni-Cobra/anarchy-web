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
}
