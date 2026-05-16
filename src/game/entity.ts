/**
 * Client-side mirror of the server's `game::entity` data model. Pure data;
 * no networking, no Three.js. Mirrors the server's `EntityComponent`
 * (`game/entity/component.rs`) and matches the wire shape decoded in
 * `net/wire_tick.ts` so a future kind slots in by adding one variant on
 * the enum and one arm where rendering specializes per kind.
 *
 * Entities live inside chunks (see `Chunk.entities` in `terrain.ts`): the
 * chunk is the unit of authoritative delivery server-side, so mirroring
 * that ownership keeps the implicit-unload rule trivial — when a chunk
 * falls out of view its entities go with it.
 */

export type EntityId = number;

/**
 * Kind of an entity. The wire enum (proto `EntityKind`) is translated in
 * `net/wire_tick.ts`; this is the network-free TypeScript twin. Variants
 * append on extension so existing values stay stable.
 */
export enum EntityKind {
  Spider = 1,
}

/**
 * Per-entity record. World tile coords (not local-to-chunk) so the
 * renderer can resolve scene position without knowing which chunk hosts
 * the entity. The server is tile-bound — `tileX`/`tileY` are integers and
 * change discretely between ticks; the renderer animates between them.
 */
export interface Entity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly tileX: number;
  readonly tileY: number;
  /**
   * Current HP (task 060). The wire only carries `> 0` (a 0-HP entity is
   * dropped server-side before its chunk ships). Mirrored here so a
   * future floating health bar / damage-flash effect has the data
   * available without a follow-up wire round-trip; not rendered this
   * iteration.
   */
  readonly health: number;
}

/** Per-kind max HP — mirrors the server's `EntityKind::max_health`. */
export function maxHealthForKind(kind: EntityKind): number {
  switch (kind) {
    case EntityKind.Spider:
      return 20;
  }
}
