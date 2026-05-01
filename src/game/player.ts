/**
 * `Player` — the entity carried by `World`.
 *
 * Mirrors the server's `game::Player` (id + continuous world position).
 * World coords follow the same convention: `+y = north`, `+x = east`.
 * Positions are floats — the wire format carries `double` x/y, and movement
 * advances by sub-tile amounts as movement intent and tick stepping land.
 */
export type PlayerId = number;

export interface Player {
  readonly id: PlayerId;
  x: number;
  y: number;
}
