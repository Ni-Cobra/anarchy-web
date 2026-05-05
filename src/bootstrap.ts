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
 */

import { REACH_BLOCKS } from "./config.js";
import {
  CHUNK_SIZE,
  HOTBAR_SLOTS,
  Inventory,
  SnapshotBuffer,
  Terrain,
  World,
  canPlaceTopBlock,
} from "./game/index.js";
import { InputController } from "./input/index.js";
import {
  applyServerMessage,
  connect,
  type LobbyIdentity,
  type LobbyRejectReason,
} from "./net/index.js";
import { Renderer } from "./render/index.js";
import {
  mountInventoryUi,
  mountSidePanel,
  type SidePanelAction,
} from "./ui/index.js";

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
  sendBreakBlock: (cx: number, cy: number, lx: number, ly: number) => void;
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
  /** Index of the locally-mirrored selected hotbar slot. */
  getSelectedHotbarSlot: () => number;
  /** True while the inventory side panel is open (toggled with `E`). */
  isInventoryOpen: () => boolean;
  // Reach + AABB overlap + top-Air gate, mirrored from the server's
  // place-validator. Exposed for e2e specs that need to assert
  // place-visibility behavior without round-tripping a real PlaceBlock.
  canPlaceAt: (cx: number, cy: number, lx: number, ly: number) => boolean;
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

const REACH_BLOCKS_SQ = REACH_BLOCKS * REACH_BLOCKS;

export function runMain(identity: LobbyIdentity): AnarchyHandle {
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

  const conn = connect(
    "ws://localhost:8080/ws",
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
        // Server rejected the Hello (only the reconnect-flagged path can
        // produce a reject today). Surface the reason to the lifecycle
        // loop *before* the teardown swallows it as a generic stop, then
        // fall through to `stop()` so the socket / listeners unwind.
        resolveLobbyReject(reason);
        stop();
      },
    },
  );
  teardowns.push(() => conn.close());

  function sendMoveIntent(dx: number, dy: number): void {
    const seq = ++actionSeq;
    conn.send({ action: { moveIntent: { dx, dy }, clientSeq: seq } });
  }

  function sendBreakBlock(cx: number, cy: number, lx: number, ly: number): void {
    conn.send({ breakBlock: { chunkCoord: { cx, cy }, localX: lx, localY: ly } });
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

  const input = new InputController({ sendMoveIntent });
  const stopInput = input.start(window);
  teardowns.push(stopInput);

  let zoomedOut = false;

  const canPlaceAt = (cx: number, cy: number, lx: number, ly: number): boolean =>
    canPlaceTopBlock(world, terrain, localPlayerId, cx, cy, lx, ly);

  // Inventory overlay: hotbar always visible, side panel toggled with `E`.
  // Mounted before the keydown handler so the listener can drive
  // `inventoryUi.toggle()` and `inventoryUi.selectHotbarSlot()` without a
  // forward reference. The UI ships authority-bound actions (SelectSlot,
  // MoveSlot) up via `sendSelectSlot` / `sendMoveSlot`; the server's
  // next `InventoryUpdate` is the canonical state.
  const inventoryUi = mountInventoryUi({
    getInventory: () => inventory,
    sendSelect: sendSelectSlot,
    sendMove: sendMoveSlot,
  });
  teardowns.push(() => inventoryUi.unmount());

  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    if (ev.code === "KeyE") {
      inventoryUi.toggle();
      return;
    }
    if (ev.code === "KeyM") {
      zoomedOut = !zoomedOut;
      renderer.setZoomedOut(zoomedOut);
      return;
    }
    // Digits 1..9 select hotbar slots 0..8. `event.code` keeps the binding
    // robust to keyboard layouts where the produced character differs.
    if (ev.code.startsWith("Digit")) {
      const digit = Number(ev.code.slice("Digit".length));
      if (digit >= 1 && digit <= HOTBAR_SLOTS) {
        inventoryUi.selectHotbarSlot(digit - 1);
        return;
      }
    }
  };
  window.addEventListener("keydown", onKeydown);
  teardowns.push(() => window.removeEventListener("keydown", onKeydown));

  // Mouse wheel cycles hotbar selection ±1 with wraparound. Up = previous.
  const onWheel = (ev: WheelEvent): void => {
    if (ev.deltaY === 0) return;
    const cur = inventoryUi.selectedHotbarSlot();
    const step = ev.deltaY > 0 ? 1 : -1;
    const next = (cur + step + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    inventoryUi.selectHotbarSlot(next);
  };
  window.addEventListener("wheel", onWheel, { passive: true });
  teardowns.push(() => window.removeEventListener("wheel", onWheel));

  const onMousemove = (ev: MouseEvent): void => {
    // Renderer drives the per-frame hover billboard from cursor NDC, so
    // every cursor sample needs to flow through `setCursorNdc` (see
    // `picker.ts`).
    renderer.setCursorNdc({
      x: (ev.clientX / window.innerWidth) * 2 - 1,
      y: -(ev.clientY / window.innerHeight) * 2 + 1,
    });
  };
  window.addEventListener("mousemove", onMousemove);
  teardowns.push(() => window.removeEventListener("mousemove", onMousemove));

  const onMousedown = (ev: MouseEvent): void => {
    if (localPlayerId === null) return;
    if (ev.button !== 0 && ev.button !== 2) return;
    const ndc = {
      x: (ev.clientX / window.innerWidth) * 2 - 1,
      y: -(ev.clientY / window.innerHeight) * 2 + 1,
    };
    const pick = renderer.pickAtCursor(ndc);
    if (!pick) return;
    const me = world.getPlayer(localPlayerId);
    if (!me) return;
    const [cx, cy] = pick.chunkCoord;
    const [lx, ly] = pick.localXY;
    const tileCenterX = cx * CHUNK_SIZE + lx + 0.5;
    const tileCenterY = cy * CHUNK_SIZE + ly + 0.5;
    const dx = tileCenterX - me.x;
    const dy = tileCenterY - me.y;
    if (dx * dx + dy * dy > REACH_BLOCKS_SQ) return;
    if (ev.button === 0) {
      // Left-click → destroy the top-layer block under the cursor.
      if (pick.layer !== "top") return;
      sendBreakBlock(cx, cy, lx, ly);
    } else {
      // Right-click → place the selected hotbar slot's block on the
      // ground tile under the cursor. Server validates that the cell is
      // currently Air on the top layer + everything else.
      sendPlaceBlock(cx, cy, lx, ly);
    }
  };
  window.addEventListener("mousedown", onMousedown);
  teardowns.push(() => window.removeEventListener("mousedown", onMousedown));

  // Suppress the browser's right-click context menu so right-click can
  // drive place-block without tearing the player out of the game.
  const onContextMenu = (ev: MouseEvent): void => ev.preventDefault();
  window.addEventListener("contextmenu", onContextMenu);
  teardowns.push(() => window.removeEventListener("contextmenu", onContextMenu));

  // Action registry for the side panel. New in-game actions go here as
  // `{ label, onClick }` entries; the panel renders them as a vertical
  // button stack without per-action DOM scaffolding.
  const sidePanelActions: ReadonlyArray<SidePanelAction> = [
    { label: "Disconnect", onClick: () => stop() },
  ];
  const sidePanel = mountSidePanel({ actions: sidePanelActions });
  teardowns.push(() => sidePanel.unmount());

  return {
    world,
    terrain,
    inventory,
    getLocalPlayerId: () => localPlayerId,
    sendMoveIntent,
    sendBreakBlock,
    sendPlaceBlock,
    sendSelectSlot,
    sendMoveSlot,
    getSelectedHotbarSlot: () => inventoryUi.selectedHotbarSlot(),
    isInventoryOpen: () => inventoryUi.isOpen(),
    canPlaceAt,
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
export async function runApp(initial: LobbyIdentity | null): Promise<void> {
  let identity = initial;
  let pendingReject: { reason: LobbyRejectReason; identity: LobbyIdentity } | null =
    null;
  for (;;) {
    if (identity === null) {
      const { showLobby, lobbyRejectMessage } = await import("./lobby.js");
      const defaults = pendingReject
        ? {
            username: pendingReject.identity.username,
            colorIndex: pendingReject.identity.colorIndex,
            reconnect: pendingReject.identity.reconnect,
            rejectMessage: lobbyRejectMessage(pendingReject.reason),
          }
        : {};
      identity = await showLobby(defaults);
      pendingReject = null;
    }
    const handle = runMain(identity);
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
