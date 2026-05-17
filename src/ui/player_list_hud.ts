/**
 * Player-list HUD — task 170.
 *
 * Top-left badge reading `N / MAX` (current connected players over the
 * server's `MAX_PLAYERS` cap). Hovering the badge expands a dropdown
 * listing every connected player by username, alphabetically; the local
 * player's row is bolded and tagged `(you)` so the list is self-orienting.
 *
 * Driven by the `RosterStore` the wire bridge pushes into on welcome
 * and on every join/leave. The HUD subscribes once on mount and
 * re-renders on each update — including in-place rerenders while the
 * dropdown is open so a join/leave doesn't flicker the panel.
 *
 * Network-free; pure DOM. The local-player id is passed in at mount
 * time so the `(you)` mark stays per-instance — re-mounting after a
 * reconnect rebinds it.
 */

import type { PlayerId, Roster, RosterEntry, RosterStore } from "../game/index.js";

const STYLE_ID = "anarchy-player-list-hud-style";
const ROOT_ID = "anarchy-player-list-hud";
const BADGE_ID = "anarchy-player-list-badge";
const DROPDOWN_ID = "anarchy-player-list-dropdown";

const STYLE = `
  #${ROOT_ID} {
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 8600;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
    user-select: none;
  }
  #${ROOT_ID}.hidden { display: none; }
  #${BADGE_ID} {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: rgba(20, 24, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    cursor: default;
  }
  #${BADGE_ID} .anarchy-player-list-icon {
    font-size: 14px;
    line-height: 1;
  }
  #${DROPDOWN_ID} {
    display: none;
    margin-top: 4px;
    padding: 6px 10px;
    background: rgba(20, 24, 30, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    min-width: 140px;
    max-height: 60vh;
    overflow-y: auto;
  }
  #${ROOT_ID}.open #${DROPDOWN_ID} { display: block; }
  #${DROPDOWN_ID} ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  #${DROPDOWN_ID} li {
    padding: 2px 0;
    font-size: 12px;
    line-height: 1.3;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    white-space: nowrap;
  }
  #${DROPDOWN_ID} li.anarchy-player-list-self {
    font-weight: 700;
    color: #ffd56a;
  }
`;

export interface PlayerListHudHandle {
  /** Imperative re-render hook (test affordance). */
  render(): void;
  /** Test handle: is the dropdown currently visible? */
  isOpen(): boolean;
  unmount(): void;
}

export interface PlayerListHudOptions {
  store: RosterStore;
  /** Local player id (for the `(you)` tag). Pass `() => null` before admission. */
  getLocalPlayerId: () => PlayerId | null;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export function formatRosterLabel(entries: number, maxPlayers: number): string {
  return `${entries} / ${maxPlayers}`;
}

/**
 * Sort roster entries alphabetically by username (case-insensitive). Ties
 * fall through to id-ascending so the wire shape's deterministic ordering
 * carries through.
 */
export function sortedRosterEntries(roster: Roster): RosterEntry[] {
  const copy = roster.entries.slice();
  copy.sort((a, b) => {
    const cmp = a.username.toLowerCase().localeCompare(b.username.toLowerCase());
    if (cmp !== 0) return cmp;
    return a.playerId - b.playerId;
  });
  return copy;
}

export function mountPlayerListHud(opts: PlayerListHudOptions): PlayerListHudHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-label", "Connected players");

  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  const icon = document.createElement("span");
  icon.className = "anarchy-player-list-icon";
  icon.textContent = "\u{1F465}"; // 👥
  const label = document.createElement("span");
  label.className = "anarchy-player-list-label";
  label.textContent = "0 / 0";
  badge.appendChild(icon);
  badge.appendChild(label);
  root.appendChild(badge);

  const dropdown = document.createElement("div");
  dropdown.id = DROPDOWN_ID;
  const list = document.createElement("ul");
  dropdown.appendChild(list);
  root.appendChild(dropdown);

  document.body.appendChild(root);

  const render = (): void => {
    const roster = opts.store.current();
    if (roster === null) {
      label.textContent = "0 / 0";
      list.innerHTML = "";
      return;
    }
    label.textContent = formatRosterLabel(roster.entries.length, roster.maxPlayers);
    const localId = opts.getLocalPlayerId();
    const sorted = sortedRosterEntries(roster);
    // Wholesale rebuild — the list is tiny (≤ MAX_PLAYERS = 32) and the
    // alphabetic order means an incremental diff isn't worth the
    // complexity. The dropdown's open/closed state lives on the parent
    // root's class so re-rendering the rows never flickers it.
    list.innerHTML = "";
    for (const entry of sorted) {
      const li = document.createElement("li");
      const isSelf = localId !== null && entry.playerId === localId;
      if (isSelf) {
        li.classList.add("anarchy-player-list-self");
        li.textContent = `${entry.username} (you)`;
      } else {
        li.textContent = entry.username;
      }
      list.appendChild(li);
    }
  };

  // Single wrapper element with `mouseenter`/`mouseleave` rather than two
  // separate listeners — the dropdown sits inside `root`, so the leave
  // fires only when the cursor exits the badge+dropdown bounding box.
  const onEnter = (): void => {
    root.classList.add("open");
  };
  const onLeave = (): void => {
    root.classList.remove("open");
  };
  root.addEventListener("mouseenter", onEnter);
  root.addEventListener("mouseleave", onLeave);

  const unsubscribe = opts.store.subscribe(() => render());
  // Subscribe already fires once if there's a current snapshot; render
  // again here is harmless and covers the "no current snapshot yet"
  // case where subscribe didn't fire.
  render();

  return {
    render,
    isOpen: () => root.classList.contains("open"),
    unmount: () => {
      unsubscribe();
      root.removeEventListener("mouseenter", onEnter);
      root.removeEventListener("mouseleave", onLeave);
      root.remove();
    },
  };
}
