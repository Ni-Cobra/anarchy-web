import type { Player, PlayerId } from "./player.js";

/**
 * Client-side mirror of the visible-to-this-client subset of the server's
 * world. Holds the latest server-authoritative view of every player whose
 * chunk currently sits in the client's view window.
 *
 * Per ADR 0003 the chunk is the unit of delivery: each `TickUpdate` carries
 * a set of chunks (full state or unmodified) and the wire layer rebuilds
 * this map from the union of players across the post-tick terrain. The
 * full-replace `applySnapshot` is the only update path; players that are
 * implicitly unloaded (their chunk fell out of view, or their chunk no
 * longer references them) drop out on the next replace.
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
      this.playersById.set(p.id, {
        id: p.id,
        x: p.x,
        y: p.y,
        facing: p.facing,
        username: p.username,
        colorIndex: p.colorIndex,
      });
    }
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
