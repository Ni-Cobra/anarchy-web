import type { Player, PlayerId } from "./player.js";

/**
 * Client-side mirror of the server's `game::World`. Holds the latest
 * server-authoritative view of every player. The render layer reads from
 * here and never touches raw protobuf or WebSocket frames — a wire layer
 * (future) translates incoming messages into calls on this class.
 *
 * Per ADR 0001 the server broadcasts a full snapshot every tick, so the
 * full-replace `applySnapshot` is the only update path needed here;
 * `removePlayer` exists so a `PlayerDespawned` notification can drop a
 * player without waiting for the next tick.
 */
export class World {
  private readonly playersById = new Map<PlayerId, Player>();

  /**
   * Replace the entire player set with `players`. Callers (the wire layer)
   * pass in the players from a `WorldSnapshot` — both the initial Welcome
   * snapshot and every per-tick `StateUpdate` go through here.
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
