import type { Player, PlayerId } from "./player.js";

/**
 * Client-side mirror of the server's `game::World`. Holds the latest
 * server-authoritative view of every player.
 *
 * Per ADR 0001 the server broadcasts a full snapshot every tick, so the
 * full-replace `applySnapshot` is the only update path needed here;
 * `removePlayer` exists so an explicit despawn can drop a player without
 * waiting for the next tick.
 */
export class World {
  private readonly playersById = new Map<PlayerId, Player>();

  /**
   * Replace the entire player set with `players`. Inputs are copied so
   * external mutation of the caller's objects can't leak into the world.
   */
  applySnapshot(players: Iterable<Player>): void {
    this.playersById.clear();
    for (const p of players) {
      this.playersById.set(p.id, { id: p.id, x: p.x, y: p.y });
    }
  }

  /** Remove `id` from the world. Returns `true` if the player was present. */
  removePlayer(id: PlayerId): boolean {
    return this.playersById.delete(id);
  }

  getPlayer(id: PlayerId): Player | undefined {
    return this.playersById.get(id);
  }

  *players(): IterableIterator<Player> {
    yield* this.playersById.values();
  }

  size(): number {
    return this.playersById.size;
  }
}
