/**
 * `ChestUpdate` message handler (task 420 / 590 / 592).
 *
 * Each `ChestUpdate` covers exactly one chest (server may emit several
 * per tick for a multi-chest open). The frame either opens / refreshes
 * a chest (`closed = false`, `slots` carries the full inventory) or
 * retires it (`closed = true`, `slots` empty). Task 592 promoted the
 * client mirror to a multi-chest map keyed by `ChestKey`; opens and
 * updates land in the map without touching any other chest's mirror.
 */
import { anarchy } from "../gen/anarchy.js";
import {
  type ChestState,
  INVENTORY_SIZE,
  type Slot,
} from "../game/index.js";

import { itemIdFromWire } from "./wire_inventory.js";

export interface ChestSink {
  readonly chestState: ChestState;
}

export function applyChestUpdate(
  update: anarchy.v1.IChestUpdate,
  sink: ChestSink | undefined,
): void {
  if (!sink) return;
  const location = update.chest;
  if (!location) {
    // Defensive: every well-formed update under the task 590 shape
    // carries a chest location. Drop a malformed frame.
    return;
  }
  const cx = location.chunkCoord?.cx ?? 0;
  const cy = location.chunkCoord?.cy ?? 0;
  const lx = location.localX ?? 0;
  const ly = location.localY ?? 0;
  const closed = update.closed === true;

  if (closed) {
    sink.chestState.closeFromWire({ cx, cy, lx, ly });
    return;
  }

  const wireSlots = update.slots ?? [];
  if (wireSlots.length !== INVENTORY_SIZE) {
    // Defensive: a misbehaving server could ship the wrong slot count.
    // Drop the frame rather than corrupt local state.
    return;
  }
  const slots: Slot[] = wireSlots.map((s): Slot => {
    const count = s.count ?? 0;
    if (count === 0) return null;
    const item = itemIdFromWire(s.item);
    if (item === null) return null;
    return { item, count };
  });
  sink.chestState.replaceFromWire({ cx, cy, lx, ly }, slots);
}
