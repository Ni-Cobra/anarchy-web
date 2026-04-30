/**
 * `Player` — the entity carried by `World`.
 *
 * Mirrors the server's `game::Player` (id + tile coordinates). World coords
 * follow the same convention: `+y = north`, `+x = east`.
 */
export type PlayerId = number;

export interface Player {
  readonly id: PlayerId;
  x: number;
  y: number;
}
