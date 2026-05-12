/**
 * Open-chest mirror (task 420 / 590 / 592). Tracks every chest the local
 * player currently has open — one `ChestPanelMirror` per chest, keyed by
 * `ChestKey`. Network-free: the wire bridge in `../net/wire_chest.ts`
 * decodes `ChestUpdate` frames and writes the resulting state here.
 *
 * Task 592 promoted this from a singleton to N mirrors. The shape mirrors
 * the server's per-player open-chests set (task 590):
 * - Each mirror carries the `ChestLocation` of the chest and its 45-slot
 *   `Inventory`.
 * - `replaceFromWire(location, slots)` either adds a new mirror (firing
 *   set listeners) or updates an existing one's contents (firing per-key
 *   listeners only).
 * - `closeFromWire(location)` retires that mirror; other mirrors are
 *   untouched.
 *
 * Two listener tiers so the chest UI orchestrator and the per-panel
 * renderers can subscribe at the right granularity:
 * - `subscribeSet` fires when chests open or close — used by the
 *   orchestrator to mount / unmount panels.
 * - `subscribeKey(key, listener)` fires when the contents of that
 *   specific chest change — used by each mounted panel so an update to
 *   chest A doesn't re-render chest B.
 */

import { type ChestKey, chestKeyOf } from "./chest_key.js";
import { Inventory, type Slot } from "./inventory.js";

/** Location of an open chest. */
export interface ChestLocation {
  readonly cx: number;
  readonly cy: number;
  readonly lx: number;
  readonly ly: number;
}

interface ChestPanelMirror {
  readonly location: ChestLocation;
  readonly inventory: Inventory;
}

export class ChestState {
  private mirrors = new Map<ChestKey, ChestPanelMirror>();
  private setListeners: Array<() => void> = [];
  private keyListeners = new Map<ChestKey, Array<() => void>>();

  /** Locations of currently-open chests, in insertion order. */
  locations(): readonly ChestLocation[] {
    const out: ChestLocation[] = [];
    for (const m of this.mirrors.values()) out.push(m.location);
    return out;
  }

  /** True iff at least one chest is open. */
  isAnyOpen(): boolean {
    return this.mirrors.size > 0;
  }

  /** True iff the chest at `loc` is open. */
  has(loc: ChestLocation): boolean {
    return this.mirrors.has(chestKeyOf(loc));
  }

  /** Inventory mirror for the chest at `loc`, or `null` if not open. */
  inventoryFor(loc: ChestLocation): Inventory | null {
    return this.mirrors.get(chestKeyOf(loc))?.inventory ?? null;
  }

  /** Inventory mirror for the chest with `key`, or `null` if not open. */
  inventoryForKey(key: ChestKey): Inventory | null {
    return this.mirrors.get(key)?.inventory ?? null;
  }

  /**
   * Open or update the chest at `location` with the given full slot
   * snapshot. A new chest fires set listeners (the orchestrator mounts a
   * panel). An existing chest fires per-key listeners only (only the
   * affected panel re-renders).
   */
  replaceFromWire(location: ChestLocation, slots: readonly Slot[]): void {
    const key = chestKeyOf(location);
    const existing = this.mirrors.get(key);
    if (existing === undefined) {
      const inv = new Inventory();
      inv.replaceFromWire(slots);
      this.mirrors.set(key, { location, inventory: inv });
      for (const l of this.setListeners.slice()) l();
      return;
    }
    existing.inventory.replaceFromWire(slots);
    const ls = this.keyListeners.get(key);
    if (ls !== undefined) {
      for (const l of ls.slice()) l();
    }
  }

  /**
   * Retire the chest at `location`. Drops its mirror and fires set
   * listeners. Per-key listeners for that chest are also cleared — any
   * panel still holding one is being torn down on the same beat.
   */
  closeFromWire(location: ChestLocation): void {
    const key = chestKeyOf(location);
    if (!this.mirrors.has(key)) return;
    this.mirrors.delete(key);
    this.keyListeners.delete(key);
    for (const l of this.setListeners.slice()) l();
  }

  /**
   * Notified when chests open or close (the set of keys changed). The
   * orchestrator subscribes here to drive panel mount / unmount.
   */
  subscribeSet(listener: () => void): () => void {
    this.setListeners.push(listener);
    return () => {
      const i = this.setListeners.indexOf(listener);
      if (i >= 0) this.setListeners.splice(i, 1);
    };
  }

  /**
   * Notified when the contents of the chest at `key` change. Fires only
   * for that specific chest — an update to A doesn't re-render B. The
   * subscription is dropped automatically on close (the listener array
   * for that key is cleared).
   */
  subscribeKey(key: ChestKey, listener: () => void): () => void {
    let ls = this.keyListeners.get(key);
    if (ls === undefined) {
      ls = [];
      this.keyListeners.set(key, ls);
    }
    ls.push(listener);
    return () => {
      const cur = this.keyListeners.get(key);
      if (cur === undefined) return;
      const i = cur.indexOf(listener);
      if (i >= 0) cur.splice(i, 1);
    };
  }
}
