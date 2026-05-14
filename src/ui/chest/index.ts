/**
 * Chest UI orchestrator. Subscribes to the client-side `ChestState`
 * multi-chest mirror and drives the [`panel_manager`] in response: mount
 * a panel when a new chest opens, unmount it when the server retires
 * the chest, and re-render the matching panel when the chest's contents
 * change.
 *
 * Per-panel chrome (header bar + X button + drag-to-move) lives in
 * [`panel_manager`]. Per-cell drag/drop wiring is delegated to the
 * shared inventory dragdrop state machine via `wireChestSlot`. The
 * orchestrator subscribes to `chestState.subscribeKey(key)` for each
 * panel it mounts so an update to chest A doesn't re-render chest B.
 */
import {
  type ChestKey,
  type ChestLocation,
  type ChestState,
  chestKeyOf,
} from "../../game/index.js";
import type { InventoryUiHandle } from "../inventory/index.js";
import { createPanelManager, type PanelManagerHandle } from "./panel_manager.js";

export interface ChestUiOptions {
  readonly chestState: ChestState;
  readonly inventoryUi: InventoryUiHandle;
  /**
   * Wire surface for the header X button. The orchestrator hands the
   * panel manager a thin wrapper that includes this; the manager calls
   * it on X-click with the panel's own `ChestLocation`.
   */
  readonly sendCloseChest: (loc: ChestLocation) => void;
  /**
   * Optional resolver for the panel header title. Called once per
   * mount; the chest UI uses this so a tombstone (task 010-tombstone)
   * panel reads "Tombstone" instead of "Chest" while the rest of the
   * chrome stays shared. Default: every panel titled "Chest".
   */
  readonly panelTitleFor?: (loc: ChestLocation) => string;
}

export interface ChestUiHandle {
  unmount(): void;
}

export function mountChestUi(options: ChestUiOptions): ChestUiHandle {
  const manager: PanelManagerHandle = createPanelManager({
    inventoryUi: options.inventoryUi,
    sendCloseChest: options.sendCloseChest,
    panelTitleFor: options.panelTitleFor,
  });

  // Per-key contents-listener unsubscribes, indexed by chestKey. Set up
  // on mount, torn down on unmount so the ChestState's `keyListeners`
  // map doesn't accumulate references to dead panels.
  const contentUnsubs = new Map<ChestKey, () => void>();

  const renderPanel = (key: ChestKey, loc: ChestLocation): void => {
    const inv = options.chestState.inventoryForKey(key);
    if (inv === null) return;
    manager.render(loc, inv);
  };

  const mountPanel = (loc: ChestLocation): void => {
    const key = chestKeyOf(loc);
    if (manager.has(loc)) return;
    manager.mount(loc);
    renderPanel(key, loc);
    const unsub = options.chestState.subscribeKey(key, () => {
      renderPanel(key, loc);
    });
    contentUnsubs.set(key, unsub);
  };

  const unmountPanel = (key: ChestKey, loc: ChestLocation): void => {
    const unsub = contentUnsubs.get(key);
    if (unsub !== undefined) {
      unsub();
      contentUnsubs.delete(key);
    }
    manager.unmount(loc);
  };

  const reconcile = (): void => {
    const liveLocs = options.chestState.locations();
    const liveKeys = new Set<ChestKey>();
    for (const loc of liveLocs) liveKeys.add(chestKeyOf(loc));

    // Drop panels whose chest is no longer open. Reconstruct the
    // location from the mounted key so `manager.unmount` finds the
    // entry — chestKeys are round-trippable.
    for (const mountedKey of manager.mountedKeys()) {
      if (!liveKeys.has(mountedKey)) {
        const [cx, cy, lx, ly] = mountedKey.split(",").map(Number);
        unmountPanel(mountedKey, { cx, cy, lx, ly });
      }
    }
    // Mount any newly-open chest. `mountPanel` is idempotent so we can
    // just iterate every live location each beat.
    for (const loc of liveLocs) mountPanel(loc);
  };

  const unsubscribeSet = options.chestState.subscribeSet(reconcile);
  reconcile();

  return {
    unmount: () => {
      unsubscribeSet();
      for (const unsub of contentUnsubs.values()) unsub();
      contentUnsubs.clear();
      manager.dispose();
    },
  };
}
