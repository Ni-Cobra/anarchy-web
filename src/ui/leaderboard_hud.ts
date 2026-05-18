/**
 * Faction-leaderboard HUD — task 240, ADR 0008.
 *
 * Top-of-screen badge: "Current leading faction: [name]" (or "No
 * factions yet"). Hover expands a dropdown listing every faction by
 * `xp` descending (id-ascending tiebreak), each row showing the
 * name, the xp count, and the bound flag's `(cx,cy:lx,ly)` coords.
 *
 * Driven by `LeaderboardStore`. Subscribes once on mount and
 * re-renders on each update (including in-place while the dropdown
 * is open so a tick-rate update doesn't flicker the panel).
 *
 * Network-free; pure DOM. The HUD does not currently mark the local
 * player's own faction — the wire shape doesn't carry "is this
 * mine?" today. Future polish can layer that on top.
 */

import {
  type FactionEntry,
  type LeaderboardStore,
  currentLeader,
  paletteColorCss,
  sortedByXpDesc,
} from "../game/index.js";

const STYLE_ID = "anarchy-leaderboard-hud-style";
const ROOT_ID = "anarchy-leaderboard-hud";
const BADGE_ID = "anarchy-leaderboard-badge";
const DROPDOWN_ID = "anarchy-leaderboard-dropdown";

const STYLE = `
  #${ROOT_ID} {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 8600;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f0;
    user-select: none;
  }
  #${ROOT_ID}.hidden { display: none; }
  #${BADGE_ID} {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(20, 24, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    cursor: default;
    white-space: nowrap;
  }
  #${BADGE_ID} .anarchy-leaderboard-icon {
    font-size: 14px;
    line-height: 1;
  }
  #${BADGE_ID} .anarchy-leaderboard-chip {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }
  #${DROPDOWN_ID} {
    display: none;
    margin: 4px auto 0;
    padding: 8px 12px;
    background: rgba(20, 24, 30, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    min-width: 240px;
    max-width: 480px;
    max-height: 60vh;
    overflow-y: auto;
  }
  #${ROOT_ID}.open #${DROPDOWN_ID} { display: block; }
  #${DROPDOWN_ID} table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12px;
  }
  #${DROPDOWN_ID} th {
    text-align: left;
    padding: 2px 6px;
    color: #c0c0c0;
    font-weight: 600;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }
  #${DROPDOWN_ID} td {
    padding: 2px 6px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    white-space: nowrap;
  }
  #${DROPDOWN_ID} .anarchy-leaderboard-chip-cell {
    width: 14px;
  }
  #${DROPDOWN_ID} .anarchy-leaderboard-coord {
    color: #a0a0a0;
    font-variant-numeric: tabular-nums;
  }
  #${ROOT_ID} .anarchy-leaderboard-empty {
    color: #c0c0c0;
    font-style: italic;
    font-weight: 500;
  }
`;

/** Render a faction's flag coords as `cx,cy:lx,ly` for the dropdown. */
export function formatFactionCoords(entry: FactionEntry): string {
  const [cx, cy] = entry.flagChunk;
  const [lx, ly] = entry.flagLocal;
  return `${cx},${cy}:${lx},${ly}`;
}

export interface LeaderboardHudHandle {
  render(): void;
  isOpen(): boolean;
  unmount(): void;
}

export interface LeaderboardHudOptions {
  store: LeaderboardStore;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export function mountLeaderboardHud(
  opts: LeaderboardHudOptions,
): LeaderboardHudHandle {
  injectStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-label", "Faction leaderboard");

  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  const icon = document.createElement("span");
  icon.className = "anarchy-leaderboard-icon";
  icon.textContent = "\u{1F3F3}"; // 🏳
  const chip = document.createElement("span");
  chip.className = "anarchy-leaderboard-chip";
  chip.style.background = "transparent";
  chip.style.display = "none";
  const label = document.createElement("span");
  label.className = "anarchy-leaderboard-label";
  label.textContent = "No factions yet";
  badge.appendChild(icon);
  badge.appendChild(chip);
  badge.appendChild(label);
  root.appendChild(badge);

  const dropdown = document.createElement("div");
  dropdown.id = DROPDOWN_ID;
  root.appendChild(dropdown);

  document.body.appendChild(root);

  const render = (): void => {
    const map = opts.store.current();
    if (map.size === 0) {
      label.classList.add("anarchy-leaderboard-empty");
      label.textContent = "No factions yet";
      chip.style.display = "none";
      dropdown.innerHTML = "";
      return;
    }
    label.classList.remove("anarchy-leaderboard-empty");
    const leader = currentLeader(map);
    if (leader !== null) {
      label.textContent = `Current leading faction: ${leader.name}`;
      chip.style.display = "inline-block";
      chip.style.background = paletteColorCss(leader.colorIndex);
    }
    // Build the dropdown table.
    const sorted = sortedByXpDesc(map);
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const heading of ["", "Faction", "XP", "Flag"]) {
      const th = document.createElement("th");
      th.textContent = heading;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    for (const entry of sorted) {
      const tr = document.createElement("tr");
      const chipCell = document.createElement("td");
      chipCell.className = "anarchy-leaderboard-chip-cell";
      const rowChip = document.createElement("span");
      rowChip.className = "anarchy-leaderboard-chip";
      rowChip.style.background = paletteColorCss(entry.colorIndex);
      chipCell.appendChild(rowChip);
      tr.appendChild(chipCell);
      const nameCell = document.createElement("td");
      nameCell.textContent = entry.name;
      tr.appendChild(nameCell);
      const xpCell = document.createElement("td");
      xpCell.textContent = entry.xp.toString();
      tr.appendChild(xpCell);
      const coordCell = document.createElement("td");
      coordCell.className = "anarchy-leaderboard-coord";
      coordCell.textContent = formatFactionCoords(entry);
      tr.appendChild(coordCell);
      body.appendChild(tr);
    }
    table.appendChild(body);
    dropdown.innerHTML = "";
    dropdown.appendChild(table);
  };

  const onEnter = (): void => {
    root.classList.add("open");
  };
  const onLeave = (): void => {
    root.classList.remove("open");
  };
  root.addEventListener("mouseenter", onEnter);
  root.addEventListener("mouseleave", onLeave);

  const unsubscribe = opts.store.subscribe(() => render());
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
