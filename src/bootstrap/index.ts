/**
 * Game-wiring entry. `runMain` brings up a single session and returns an
 * `AnarchyHandle` that carries a `stop()` to tear everything back down.
 * `runApp` owns the lobby ↔ game lifecycle loop: show the lobby, hand
 * the chosen identity to `constructSession`, await a Disconnect, then
 * re-show the lobby and repeat.
 *
 * Lives at the same layer as `main.ts` — both modules are allowed to touch
 * `window` / `document` directly. Per the project charter this is the only
 * exception to the "browser globals stay in `main.ts`" rule, and exists so
 * `main.ts` reads at a glance.
 *
 * ## Submodules
 *
 * Logical concerns are split into siblings so this entry stays focused
 * on the public seam (`AnarchyHandle` re-export, the thin `runMain`,
 * the `runApp` lobby loop). New code should land in the narrowest
 * sibling rather than growing this file:
 * - [`./session`] — the session-construction factory. Builds every
 *   live object (world / buffer / terrain / renderer / connection /
 *   input / overlays), wires the callback graph, and returns the
 *   `AnarchyHandle` + a `dispose()` for clean re-entry.
 * - [`./keybindings`] — `keydown` + `wheel` (inventory toggle, hotbar
 *   select, zoom toggles).
 * - [`./break_place`] — `mousemove` + `mousedown` + `mouseup` + the
 *   `contextmenu` suppression that drive held-break and place-block.
 * - [`./actions`] — wire-frame senders for every player action; owns
 *   the per-session `actionSeq` counter.
 * - [`./register_flow`] — in-game `RegisterAccount` flow (ADR 0007);
 *   owns the modal + pending-result + `registered` latch.
 * - [`./toast`] — tiny in-session toast banner mounted near the bottom.
 */

import type { LobbyIdentity, LobbyRejectReason } from "../net/index.js";
import { constructSession, type AnarchyHandle } from "./session.js";

export type { AnarchyHandle } from "./session.js";

/** Default WebSocket endpoint. Overridden by `runApp`'s `wsUrl` arg, which
 * `main.ts` populates from the `?server-port=NNNN` query param so the
 * accounts e2e spec can target its own dedicated server. */
const DEFAULT_WS_URL = "ws://localhost:8080/ws";

export function runMain(
  identity: LobbyIdentity,
  wsUrl: string = DEFAULT_WS_URL,
): AnarchyHandle {
  return constructSession({ identity, wsUrl }).handle;
}

/**
 * Lifecycle loop: show the lobby (unless we already have an identity
 * from a query-string bypass), hand it to `constructSession`, wait for
 * a Disconnect, then return to the lobby. `window.__anarchy` always
 * points at the *current* live session — set on each spawn, cleared on
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
  wsUrl: string = DEFAULT_WS_URL,
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
    const session = constructSession({ identity, wsUrl });
    window.__anarchy = session.handle;
    const sessionIdentity = identity;
    await session.handle.stopped;
    const reason = await session.handle.lobbyReject;
    window.__anarchy = undefined;
    if (reason !== null) {
      pendingReject = { reason, identity: sessionIdentity };
    }
    identity = null;
  }
}
