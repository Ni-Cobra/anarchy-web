/**
 * Chest UI orchestrator. Subscribes to the client-side `ChestState`
 * mirror and drives the [`panel_manager`] in response: mount the panel
 * when the local player opens a chest, unmount it when the server
 * confirms the close. Today (task 591) the client mirror is still a
 * singleton — at most one panel is mounted at a time — but the panel
 * manager is shaped to handle N (task 592 promotes the mirror).
 *
 * Per-panel chrome (header bar + X button + drag-to-move) lives in
 * [`panel_manager`]. Per-cell drag/drop wiring is delegated to the
 * shared inventory dragdrop state machine via `wireChestSlot`.
 */
import { type ChestLocation, type ChestState } from "../../game/index.js";
import type { InventoryUiHandle } from "../inventory/index.js";
import { chestKeyOf } from "./chest_key.js";
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
}

export interface ChestUiHandle {
  unmount(): void;
}

export function mountChestUi(options: ChestUiOptions): ChestUiHandle {
  const manager: PanelManagerHandle = createPanelManager({
    inventoryUi: options.inventoryUi,
    sendCloseChest: options.sendCloseChest,
  });

  const reconcile = (): void => {
    const loc = options.chestState.location();
    if (loc === null) {
      if (manager.mountedKeys().length > 0) manager.unmountAll();
      return;
    }
    const key = chestKeyOf(loc);
    // Single-panel today: drop any panel that doesn't match the open
    // chest's key. Task 592 widens this.
    for (const mountedKey of manager.mountedKeys()) {
      if (mountedKey !== key) {
        // Reconstruct the location to call unmount; cheap since the key
        // is the location string-encoded.
        const [cx, cy, lx, ly] = mountedKey.split(",").map(Number);
        manager.unmount({ cx, cy, lx, ly });
      }
    }
    if (!manager.has(loc)) manager.mount(loc);
    manager.render(loc, options.chestState.inventory());
  };

  const unsubscribe = options.chestState.subscribe(reconcile);
  reconcile();

  return {
    unmount: () => {
      unsubscribe();
      manager.dispose();
    },
  };
}
