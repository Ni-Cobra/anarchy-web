/**
 * Game-wiring entry. Constructs the network-free game state, the renderer,
 * the network connection, the keyboard input controller, the inventory
 * overlay, and the destroy-mouse handler, and registers the DOM listeners
 * they share.
 *
 * `runMain` brings up a single session and returns an `AnarchyHandle` that
 * carries a `stop()` to tear everything back down. `runApp` owns the
 * lobby ↔ game lifecycle loop: show the lobby, hand the chosen identity
 * to `runMain`, await a Disconnect, then re-show the lobby and repeat.
 *
 * Lives at the same layer as `main.ts` — both modules are allowed to touch
 * `window` / `document` directly. Per the project charter this is the only
 * exception to the "browser globals stay in `main.ts`" rule, and exists so
 * `main.ts` reads at a glance.
 *
 * ## Submodules
 *
 * The window-level listener wiring is split out so this entry stays
 * focused on construction, the action-send seam, and lifecycle:
 * - [`./keybindings`] — `keydown` + `wheel` (inventory toggle, hotbar
 *   select, zoom toggles).
 * - [`./break_place`] — `mousemove` + `mousedown` + `mouseup` + the
 *   `contextmenu` suppression that drive held-break and place-block.
 */

import {
  Inventory,
  SnapshotBuffer,
  Terrain,
  type ToolKind,
  World,
  canPlaceTopBlock,
} from "../game/index.js";
import { InputController } from "../input/index.js";
import {
  applyServerMessage,
  connect,
  type LobbyIdentity,
  type LobbyRejectReason,
  type RegisterResultStatus,
  type WireBlockEditEvent,
  type WireTargetingStateEvent,
} from "../net/index.js";
import { Renderer, type GhostState } from "../render/index.js";
import {
  mountCoordsHud,
  mountCraftingUi,
  mountInventoryUi,
  mountSidePanel,
  showRegisterModal,
  type CraftingUiHandle,
  type InventoryUiHandle,
  type RegisterModalHandle,
  type SidePanelAction,
} from "../ui/index.js";
import { attachBreakAndPlace } from "./break_place.js";
import { attachKeybindings } from "./keybindings.js";
import { mountToastHost } from "./toast.js";

/**
 * Test handle exposed on `window.__anarchy`. Kept narrow on purpose: only
 * the seams Playwright needs to drive the app without poking internals.
 *
 * `stop()` tears down the whole session — sockets, listeners, timers,
 * Three.js resources, side panel + inventory DOM. `stopped` resolves
 * once the teardown finishes, so the lifecycle loop in `runApp` can
 * wait for a Disconnect and re-show the lobby.
 */
export interface AnarchyHandle {
  world: World;
  terrain: Terrain;
  /**
   * Local-player inventory mirror, populated by `InventoryUpdate` frames
   * the server ships immediately after admission and on every tick the
   * inventory mutates. The hotbar / side-panel overlay subscribes to this
   * mirror and re-renders on each change. Exposed on the test handle so
   * e2e specs can pin the wire surface end-to-end.
   */
  inventory: Inventory;
  getLocalPlayerId: () => number | null;
  sendMoveIntent: (dx: number, dy: number) => void;
  /**
   * Held-break wire surface (ADR 0006). Pass a `BreakTarget` to start /
   * retarget the held break — server damages the cell `BREAK_DAMAGE_PER_TICK`
   * per tick until durability hits zero — or `null` to release. Client-side
   * latched state owns the heartbeat resend and the on-mouseup release; tests
   * call this directly to drive the wire round-trip without simulating
   * mousedown/up.
   */
  sendBreakIntent: (
    target: { cx: number; cy: number; lx: number; ly: number } | null,
  ) => void;
  /**
   * Send a place-block action. The placed kind is now decided
   * authoritatively by the server from the player's selected hotbar slot
   * — the client no longer ships a kind on the wire (task 040).
   */
  sendPlaceBlock: (cx: number, cy: number, lx: number, ly: number) => void;
  /** Send a hotbar-selection action; bumps the local action seq. */
  sendSelectSlot: (slot: number) => void;
  /** Send an inventory drag-drop action; bumps the local action seq. */
  sendMoveSlot: (src: number, dst: number) => void;
  /**
   * Ship a `CraftRequest(recipe_id)` action up to the server (task 090
   * client wiring). The server re-validates ingredient availability and
   * inventory fit; failures are silently dropped, success surfaces in the
   * next `InventoryUpdate`.
   */
  sendCraft: (recipeId: string) => void;
  /**
   * Equip the tool at `sourceSlot` into the equipment slot named by
   * `kind` (task 100). Server validates that the source slot holds a
   * tool of the matching kind and atomically swaps the source slot with
   * the equipment slot.
   */
  sendEquipTool: (sourceSlot: number, kind: ToolKind) => void;
  /**
   * Unequip the tool from the equipment slot named by `kind`. Server
   * places the tool into the first empty inventory slot, dropping
   * silently if the inventory is full.
   */
  sendUnequipTool: (kind: ToolKind) => void;
  /** Index of the locally-mirrored selected hotbar slot. */
  getSelectedHotbarSlot: () => number;
  /** True while the inventory side panel is open (toggled with `E`). */
  isInventoryOpen: () => boolean;
  // Reach + AABB overlap + top-Air gate, mirrored from the server's
  // place-validator. Exposed for e2e specs that need to assert
  // place-visibility behavior without round-tripping a real PlaceBlock.
  canPlaceAt: (cx: number, cy: number, lx: number, ly: number) => boolean;
  /**
   * Test handle (task 070): authoritative latest set of held-break
   * targeting overlays for any player visible to this client. Mirrors
   * the wire bridge's `applyTargets` call exactly — wholesale replace
   * each tick a `TickUpdate.targets` arrives.
   */
  getActiveTargetingStates: () => readonly WireTargetingStateEvent[];
  /**
   * Test handle (task 070): total count of `BlockEdit` events observed
   * on this connection since session start. Lets a Playwright spec assert
   * "client B saw the place / break that client A initiated" without
   * inspecting renderer internals.
   */
  getObservedBlockEditCount: () => number;
  /**
   * Test handle (task 020): latest ghost-block preview state computed by
   * the renderer's per-frame driver, or `null` when no preview is shown
   * (held slot empty / non-placeable, or no valid target under cursor).
   */
  getGhostState: () => GhostState | null;
  /**
   * Test handle (task 020): drive the renderer's cursor NDC directly,
   * bypassing the page's mouse event plumbing. Lets a Playwright spec aim
   * the ghost preview at a known tile without computing screen-space
   * coordinates from the live camera transform. Pass `null` to clear.
   */
  setCursorNdc: (ndc: { x: number; y: number } | null) => void;
  stop: () => void;
  readonly stopped: Promise<void>;
  /**
   * Resolves with a `LobbyRejectReason` if the server rejected the
   * lobby Hello (today: only the reconnect-flagged path can produce a
   * reject), or `null` if the session ended normally / via `stop()` /
   * via socket close. The lifecycle loop in `runApp` waits on this to
   * decide whether to re-show the lobby with a server-side error
   * message above the form.
   */
  readonly lobbyReject: Promise<LobbyRejectReason | null>;
}

/** Default WebSocket endpoint. Overridden by `runApp`'s `wsUrl` arg, which
 * `main.ts` populates from the `?server-port=NNNN` query param so the
 * accounts e2e spec can target its own dedicated server. */
const DEFAULT_WS_URL = "ws://localhost:8080/ws";

export function runMain(
  identity: LobbyIdentity,
  wsUrl: string = DEFAULT_WS_URL,
): AnarchyHandle {
  // Every owned resource (listener, interval, rAF, WS, mesh, DOM node)
  // pushes a teardown into this list at construction time. `stop()`
  // drains the list in reverse so dependencies are torn down before what
  // they depend on. Keeping this list co-located with the construction
  // is what guarantees a clean Disconnect — leaks here surface as
  // duplicated input/network behavior on the next session.
  const teardowns: Array<() => void> = [];
  let stopping = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => {
    resolveStopped = r;
  });
  let resolveLobbyReject!: (reason: LobbyRejectReason | null) => void;
  const lobbyReject = new Promise<LobbyRejectReason | null>((r) => {
    resolveLobbyReject = r;
  });
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    while (teardowns.length > 0) {
      const fn = teardowns.pop()!;
      try {
        fn();
      } catch (err) {
        console.error("[disconnect] teardown failed", err);
      }
    }
    // If the server never sent a LobbyReject the promise has nothing to
    // carry — resolve with null so the lifecycle loop knows the
    // disconnect was a normal one.
    resolveLobbyReject(null);
    resolveStopped();
  };

  const world = new World();
  const buffer = new SnapshotBuffer();
  const terrain = new Terrain();
  const inventory = new Inventory();
  // Forward-declared so the renderer's per-frame ghost driver can read the
  // currently-selected hotbar slot. The UI is mounted later in this
  // function (it depends on `sendSelectSlot` / `sendMoveSlot`, which in
  // turn need `conn`); the renderer's animation loop only runs after the
  // current synchronous tick finishes, by which time `inventoryUi` is set.
  let inventoryUi!: InventoryUiHandle;
  let craftingUi!: CraftingUiHandle;
  const renderer = new Renderer(
    world,
    buffer,
    document.body,
    {
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
    },
    terrain,
    undefined,
    undefined,
    inventory,
    () => inventoryUi.selectedHotbarSlot(),
  );
  teardowns.push(() => renderer.dispose());

  const onResize = (): void => {
    renderer.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);
  teardowns.push(() => window.removeEventListener("resize", onResize));

  let localPlayerId: number | null = null;
  // Per-client monotonic action sequence. Mirrored into every outbound
  // `ClientAction.client_seq`. Per ADR 0003 prediction is removed; the
  // client no longer reconciles against the seq, but the server still
  // expects a monotonic counter and may surface it again later.
  let actionSeq = 0;

  // Test-handle observability for the task 070 effects feed. The
  // renderer-visible effects layer is internal; these mirrors give
  // Playwright (and unit tests for the bootstrap wire) a way to assert
  // that the new wire surface is being delivered end-to-end.
  let observedBlockEditCount = 0;
  let activeTargets: readonly WireTargetingStateEvent[] = [];

  // Pending result handler for an in-flight `RegisterAccount` submission
  // (ADR 0007). Set when the user submits the modal; cleared by the
  // server's `RegisterAccountResult` reply (or by `stop()` on disconnect).
  let pendingRegisterResult: ((status: RegisterResultStatus) => void) | null =
    null;
  let registered = false;

  const conn = connect(
    wsUrl,
    identity,
    (msg) => {
      applyServerMessage(msg, {
        world,
        buffer,
        terrain,
        terrainSink: {
          onChunkLoaded: (cx, cy) => renderer.applyChunkLoaded(cx, cy),
          onChunkUnloaded: (cx, cy) => renderer.applyChunkUnloaded(cx, cy),
        },
        effectsSink: {
          onBlockEdit: (event: WireBlockEditEvent) => {
            observedBlockEditCount += 1;
            renderer.onBlockEdit(event);
          },
          applyTargets: (targets: readonly WireTargetingStateEvent[]) => {
            activeTargets = targets;
            renderer.applyTargetingStates(targets);
          },
        },
        inventory,
        local: {
          setLocalPlayerId: (id) => {
            localPlayerId = id;
            renderer.setLocalPlayerId(id);
          },
          getLocalPlayerId: () => localPlayerId,
        },
      });
    },
    {
      onLobbyReject: (reason) => {
        // Server rejected the Hello. Surface the reason to the lifecycle
        // loop *before* the teardown swallows it as a generic stop, then
        // fall through to `stop()` so the socket / listeners unwind.
        resolveLobbyReject(reason);
        stop();
      },
      onRegisterResult: (status) => {
        if (pendingRegisterResult) {
          const cb = pendingRegisterResult;
          pendingRegisterResult = null;
          cb(status);
        }
      },
    },
  );
  teardowns.push(() => conn.close());

  function sendRegisterAccount(password: string): void {
    conn.send({ registerAccount: { password } });
  }

  function sendMoveIntent(dx: number, dy: number): void {
    const seq = ++actionSeq;
    conn.send({ action: { moveIntent: { dx, dy }, clientSeq: seq } });
  }

  function sendBreakIntent(
    target: { cx: number; cy: number; lx: number; ly: number } | null,
  ): void {
    const seq = ++actionSeq;
    if (target === null) {
      conn.send({ breakIntent: { clientSeq: seq } });
    } else {
      conn.send({
        breakIntent: {
          target: {
            chunkCoord: { cx: target.cx, cy: target.cy },
            localX: target.lx,
            localY: target.ly,
          },
          clientSeq: seq,
        },
      });
    }
  }

  function sendPlaceBlock(cx: number, cy: number, lx: number, ly: number): void {
    conn.send({
      placeBlock: {
        chunkCoord: { cx, cy },
        localX: lx,
        localY: ly,
      },
    });
  }

  function sendSelectSlot(slot: number): void {
    const seq = ++actionSeq;
    conn.send({ selectSlot: { slot, clientSeq: seq } });
  }

  function sendMoveSlot(src: number, dst: number): void {
    const seq = ++actionSeq;
    conn.send({ moveSlot: { src, dst, clientSeq: seq } });
  }

  function sendCraft(recipeId: string): void {
    const seq = ++actionSeq;
    conn.send({ craft: { recipeId, clientSeq: seq } });
  }

  function toolKindToWire(kind: ToolKind): number {
    // Mirrors `proto::v1::ToolKind`. The wire enum lives in
    // `src/gen/anarchy.js`; we use the numeric codes directly so callers
    // outside the wire bridge don't need to import generated types.
    return kind === "pickaxe" ? 1 : 2;
  }

  function sendEquipTool(sourceSlot: number, kind: ToolKind): void {
    const seq = ++actionSeq;
    conn.send({
      equipTool: {
        sourceSlot,
        toolKind: toolKindToWire(kind),
        clientSeq: seq,
      },
    });
  }

  function sendUnequipTool(kind: ToolKind): void {
    const seq = ++actionSeq;
    conn.send({
      unequipTool: { toolKind: toolKindToWire(kind), clientSeq: seq },
    });
  }

  const input = new InputController({ sendMoveIntent });
  const stopInput = input.start(window);
  teardowns.push(stopInput);

  const canPlaceAt = (cx: number, cy: number, lx: number, ly: number): boolean =>
    canPlaceTopBlock(world, terrain, localPlayerId, cx, cy, lx, ly);

  // Inventory overlay: hotbar always visible, side panel toggled with `E`.
  // Mounted before the keydown handler so the listener can drive
  // `inventoryUi.toggle()` and `inventoryUi.selectHotbarSlot()` without a
  // forward reference. The UI ships authority-bound actions (SelectSlot,
  // MoveSlot) up via `sendSelectSlot` / `sendMoveSlot`; the server's
  // next `InventoryUpdate` is the canonical state.
  const inventoryUiInner = mountInventoryUi({
    getInventory: () => inventory,
    sendSelect: sendSelectSlot,
    sendMove: sendMoveSlot,
    sendEquip: sendEquipTool,
    sendUnequip: sendUnequipTool,
  });
  teardowns.push(() => inventoryUiInner.unmount());

  // Crafting panel slides in alongside the inventory side panel — same
  // open/close lifecycle, mirrored on the right edge. Server snapshots
  // (`InventoryUpdate.craftable_recipe_ids`) drive the row list; clicking
  // a row ships a `CraftRequest`.
  craftingUi = mountCraftingUi({
    getInventory: () => inventory,
    sendCraft,
  });
  teardowns.push(() => craftingUi.unmount());

  // Wrap the inventory handle so every open/close path also drives the
  // crafting panel. Both panels carry the same `open` state — the
  // crafting panel is a sibling widget, not a child.
  inventoryUi = {
    isOpen: () => inventoryUiInner.isOpen(),
    setOpen: (open) => {
      inventoryUiInner.setOpen(open);
      craftingUi.setOpen(open);
    },
    toggle: () => {
      const next = !inventoryUiInner.isOpen();
      inventoryUiInner.setOpen(next);
      craftingUi.setOpen(next);
    },
    selectedHotbarSlot: () => inventoryUiInner.selectedHotbarSlot(),
    selectHotbarSlot: (slot) => inventoryUiInner.selectHotbarSlot(slot),
    render: () => inventoryUiInner.render(),
    unmount: () => inventoryUiInner.unmount(),
  };

  // Top-left coordinates readout. Pumped from a dedicated rAF loop that
  // reads the latest authoritative `World` snapshot — independent of the
  // renderer's animation loop so the readout keeps refreshing even if the
  // canvas is occluded (rAF still fires when the tab is focused).
  const coordsHud = mountCoordsHud();
  let coordsRaf = 0;
  const pumpCoords = (): void => {
    const id = localPlayerId;
    const me = id === null ? null : world.getPlayer(id);
    coordsHud.update(me ? { x: me.x, y: me.y } : null);
    coordsRaf = window.requestAnimationFrame(pumpCoords);
  };
  coordsRaf = window.requestAnimationFrame(pumpCoords);
  teardowns.push(() => {
    window.cancelAnimationFrame(coordsRaf);
    coordsHud.unmount();
  });

  teardowns.push(attachKeybindings(window, { inventoryUi, renderer }));
  teardowns.push(
    attachBreakAndPlace(window, {
      world,
      renderer,
      getLocalPlayerId: () => localPlayerId,
      getInventory: () => inventory,
      sendBreakIntent,
      sendPlaceBlock,
    }),
  );

  const toast = mountToastHost();
  teardowns.push(() => toast.unmount());

  let openRegisterModal: () => void = () => {};
  let registerModal: RegisterModalHandle | null = null;
  teardowns.push(() => {
    registerModal?.close();
    registerModal = null;
    pendingRegisterResult = null;
  });

  // Action registry for the side panel. New in-game actions go here as
  // `{ label, onClick }` entries; the panel renders them as a vertical
  // button stack without per-action DOM scaffolding.
  function buildSidePanelActions(): ReadonlyArray<SidePanelAction> {
    const actions: SidePanelAction[] = [
      { label: "Disconnect", onClick: () => stop() },
    ];
    if (!registered) {
      actions.push({
        label: "Register account",
        onClick: () => openRegisterModal(),
      });
    }
    return actions;
  }
  let sidePanel = mountSidePanel({ actions: buildSidePanelActions() });
  teardowns.push(() => sidePanel.unmount());

  function rebuildSidePanel(): void {
    const wasOpen = sidePanel.isOpen();
    sidePanel.unmount();
    sidePanel = mountSidePanel({ actions: buildSidePanelActions() });
    if (wasOpen) sidePanel.setOpen(true);
  }

  openRegisterModal = (): void => {
    if (registerModal !== null) return;
    if (registered) return;
    if (localPlayerId === null) return;
    const me = world.getPlayer(localPlayerId);
    const username = me?.username ?? identity.username;
    registerModal = showRegisterModal({
      username,
      onSubmit: (password) => {
        registerModal = null;
        pendingRegisterResult = (status) => {
          if (status === "ok") {
            registered = true;
            toast.show("Account registered.", "ok");
            rebuildSidePanel();
          } else if (status === "already-registered") {
            toast.show("This username is already registered.", "error");
          } else {
            toast.show("Registration failed. Please try again.", "error");
          }
        };
        sendRegisterAccount(password);
      },
      onCancel: () => {
        registerModal = null;
      },
    });
  };

  return {
    world,
    terrain,
    inventory,
    getLocalPlayerId: () => localPlayerId,
    sendMoveIntent,
    sendBreakIntent,
    sendPlaceBlock,
    sendSelectSlot,
    sendMoveSlot,
    sendCraft,
    sendEquipTool,
    sendUnequipTool,
    getSelectedHotbarSlot: () => inventoryUi.selectedHotbarSlot(),
    isInventoryOpen: () => inventoryUi.isOpen(),
    canPlaceAt,
    getActiveTargetingStates: () => activeTargets,
    getObservedBlockEditCount: () => observedBlockEditCount,
    getGhostState: () => renderer.getGhostState(),
    setCursorNdc: (ndc) => renderer.setCursorNdc(ndc),
    stop,
    stopped,
    lobbyReject,
  };
}

/**
 * Lifecycle loop: show the lobby (unless we already have an identity
 * from a query-string bypass), hand it to `runMain`, wait for a
 * Disconnect, then return to the lobby. `window.__anarchy` always points
 * at the *current* live session — set on each spawn, cleared on
 * Disconnect — so Playwright's test handle keeps working across cycles.
 *
 * If the server replied to the Hello with a `LobbyReject` (today: only
 * the reconnect-flagged path can fail this way), the lobby is re-shown
 * with the reason rendered above the form and the user's prior inputs
 * pre-filled so they can fix the choice (uncheck reconnect, type a
 * different username) without retyping everything.
 */
export async function runApp(
  initial: LobbyIdentity | null,
  wsUrl?: string,
): Promise<void> {
  let identity = initial;
  let pendingReject: { reason: LobbyRejectReason; identity: LobbyIdentity } | null =
    null;
  for (;;) {
    if (identity === null) {
      const { showLobby, lobbyRejectMessage } = await import("../lobby.js");
      const defaults = pendingReject
        ? {
            username: pendingReject.identity.username,
            colorIndex: pendingReject.identity.colorIndex,
            // The "username taken" case asks the user to switch to
            // Returning + enter a password — surface that mode so they
            // don't have to click the tab themselves.
            mode:
              pendingReject.reason === "username-taken-by-registration" ||
              pendingReject.identity.reconnect
                ? ("returning" as const)
                : ("new" as const),
            rejectMessage: lobbyRejectMessage(pendingReject.reason),
          }
        : {};
      identity = await showLobby(defaults);
      pendingReject = null;
    }
    const handle = runMain(identity, wsUrl);
    window.__anarchy = handle;
    const sessionIdentity = identity;
    await handle.stopped;
    const reason = await handle.lobbyReject;
    window.__anarchy = undefined;
    if (reason !== null) {
      pendingReject = { reason, identity: sessionIdentity };
    }
    identity = null;
  }
}
