// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Roster, RosterStore } from "../game/index.js";
import {
  formatRosterLabel,
  mountPlayerListHud,
  sortedRosterEntries,
} from "./player_list_hud.js";

const ROOT_ID = "anarchy-player-list-hud";
const BADGE_ID = "anarchy-player-list-badge";
const DROPDOWN_ID = "anarchy-player-list-dropdown";

function rosterOf(
  entries: Array<[number, string]>,
  maxPlayers = 32,
): Roster {
  return {
    entries: entries.map(([playerId, username]) => ({ playerId, username })),
    maxPlayers,
  };
}

function rows(): HTMLLIElement[] {
  return Array.from(
    document.querySelectorAll<HTMLLIElement>(`#${DROPDOWN_ID} li`),
  );
}

describe("formatRosterLabel", () => {
  it("renders the N / max badge text", () => {
    expect(formatRosterLabel(3, 32)).toBe("3 / 32");
    expect(formatRosterLabel(0, 32)).toBe("0 / 32");
  });
});

describe("sortedRosterEntries", () => {
  it("sorts alphabetically by username, case-insensitive", () => {
    const sorted = sortedRosterEntries(
      rosterOf([
        [1, "charlie"],
        [2, "Alice"],
        [3, "bob"],
      ]),
    );
    expect(sorted.map((e) => e.username)).toEqual(["Alice", "bob", "charlie"]);
  });

  it("breaks username ties by player id ascending", () => {
    const sorted = sortedRosterEntries(
      rosterOf([
        [3, "Same"],
        [1, "Same"],
      ]),
    );
    expect(sorted.map((e) => e.playerId)).toEqual([1, 3]);
  });
});

describe("mountPlayerListHud", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("paints the N / max badge from the current roster", () => {
    const store = new RosterStore();
    store.apply(rosterOf([[1, "Solo"]]));
    const hud = mountPlayerListHud({
      store,
      getLocalPlayerId: () => 1,
    });
    const badge = document.getElementById(BADGE_ID)!;
    expect(badge.textContent).toContain("1 / 32");
    hud.unmount();
  });

  it("starts the dropdown closed and opens on mouseenter / closes on mouseleave", () => {
    const store = new RosterStore();
    store.apply(rosterOf([[1, "Solo"]]));
    const hud = mountPlayerListHud({ store, getLocalPlayerId: () => null });
    expect(hud.isOpen()).toBe(false);

    const root = document.getElementById(ROOT_ID)!;
    root.dispatchEvent(new Event("mouseenter"));
    expect(hud.isOpen()).toBe(true);

    root.dispatchEvent(new Event("mouseleave"));
    expect(hud.isOpen()).toBe(false);

    hud.unmount();
  });

  it("renders rows in alphabetical order with the local player tagged (you)", () => {
    const store = new RosterStore();
    store.apply(
      rosterOf([
        [1, "Charlie"],
        [2, "Alice"],
        [3, "Bob"],
      ]),
    );
    const hud = mountPlayerListHud({ store, getLocalPlayerId: () => 3 });
    const li = rows();
    expect(li.map((row) => row.textContent)).toEqual([
      "Alice",
      "Bob (you)",
      "Charlie",
    ]);
    expect(li[1].classList.contains("anarchy-player-list-self")).toBe(true);
    expect(li[0].classList.contains("anarchy-player-list-self")).toBe(false);
    hud.unmount();
  });

  it("re-renders in place when the roster store updates", () => {
    const store = new RosterStore();
    store.apply(rosterOf([[1, "Solo"]]));
    const hud = mountPlayerListHud({ store, getLocalPlayerId: () => 1 });
    expect(rows().length).toBe(1);

    store.apply(
      rosterOf([
        [1, "Solo"],
        [2, "Newcomer"],
      ]),
    );
    expect(rows().length).toBe(2);
    expect(document.getElementById(BADGE_ID)!.textContent).toContain("2 / 32");
    hud.unmount();
  });

  it("re-render keeps the dropdown open if it was open before the update", () => {
    const store = new RosterStore();
    store.apply(rosterOf([[1, "Solo"]]));
    const hud = mountPlayerListHud({ store, getLocalPlayerId: () => 1 });
    const root = document.getElementById(ROOT_ID)!;
    root.dispatchEvent(new Event("mouseenter"));
    expect(hud.isOpen()).toBe(true);

    store.apply(
      rosterOf([
        [1, "Solo"],
        [2, "Late"],
      ]),
    );
    // Dropdown stays open across the in-place re-render.
    expect(hud.isOpen()).toBe(true);
    expect(rows().length).toBe(2);
    hud.unmount();
  });

  it("renders a sensible default before any roster snapshot has arrived", () => {
    const store = new RosterStore();
    const hud = mountPlayerListHud({ store, getLocalPlayerId: () => null });
    const badge = document.getElementById(BADGE_ID)!;
    expect(badge.textContent).toContain("0 / 0");
    expect(rows()).toEqual([]);
    hud.unmount();
  });

  it("unmount removes the root and stops receiving roster updates", () => {
    const store = new RosterStore();
    store.apply(rosterOf([[1, "Solo"]]));
    const hud = mountPlayerListHud({ store, getLocalPlayerId: () => 1 });
    expect(document.getElementById(ROOT_ID)).not.toBeNull();

    hud.unmount();
    expect(document.getElementById(ROOT_ID)).toBeNull();
    // A post-unmount apply must not throw or re-add the DOM.
    store.apply(rosterOf([[1, "Solo"], [2, "Other"]]));
    expect(document.getElementById(ROOT_ID)).toBeNull();
  });
});
