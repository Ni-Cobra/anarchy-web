// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type FactionEntry,
  LeaderboardStore,
} from "../game/index.js";

import {
  formatFactionCoords,
  mountLeaderboardHud,
} from "./leaderboard_hud.js";

function entry(
  id: number,
  name: string,
  xp: number,
  colorIndex = 0,
  flagChunk: [number, number] = [0, 0],
  flagLocal: [number, number] = [0, 0],
): FactionEntry {
  return { id, name, xp, colorIndex, flagChunk, flagLocal };
}

describe("formatFactionCoords", () => {
  test("renders chunk + local as cx,cy:lx,ly", () => {
    expect(
      formatFactionCoords(entry(1, "A", 0, 0, [-3, 7], [5, 11])),
    ).toBe("-3,7:5,11");
  });
});

describe("mountLeaderboardHud", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("renders 'No factions yet' before any data", () => {
    const store = new LeaderboardStore();
    const handle = mountLeaderboardHud({ store });
    const label = document.querySelector(".anarchy-leaderboard-label");
    expect(label?.textContent).toBe("No factions yet");
    handle.unmount();
  });

  test("renders the current leader's name after a snapshot", () => {
    const store = new LeaderboardStore();
    const handle = mountLeaderboardHud({ store });
    store.applySnapshot([entry(1, "Alpha", 0)]);
    const label = document.querySelector(".anarchy-leaderboard-label");
    expect(label?.textContent).toBe("Current leading faction: Alpha");
    handle.unmount();
  });

  test("dropdown is hidden by default and opens on mouseenter", () => {
    const store = new LeaderboardStore();
    const handle = mountLeaderboardHud({ store });
    store.applySnapshot([entry(1, "Alpha", 0), entry(2, "Bravo", 5)]);
    expect(handle.isOpen()).toBe(false);
    const root = document.getElementById("anarchy-leaderboard-hud")!;
    root.dispatchEvent(new MouseEvent("mouseenter"));
    expect(handle.isOpen()).toBe(true);
    root.dispatchEvent(new MouseEvent("mouseleave"));
    expect(handle.isOpen()).toBe(false);
    handle.unmount();
  });

  test("dropdown lists factions sorted by xp desc", () => {
    const store = new LeaderboardStore();
    mountLeaderboardHud({ store });
    store.applySnapshot([
      entry(1, "Alpha", 0),
      entry(2, "Bravo", 10),
      entry(3, "Charlie", 5),
    ]);
    const rows = document.querySelectorAll(
      "#anarchy-leaderboard-dropdown tbody tr",
    );
    expect(rows.length).toBe(3);
    // The second column is the faction name; the first is the chip cell.
    const names = Array.from(rows).map(
      (r) => r.children[1]?.textContent ?? "",
    );
    expect(names).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  test("renders updates on delta apply", () => {
    const store = new LeaderboardStore();
    const handle = mountLeaderboardHud({ store });
    store.applySnapshot([entry(1, "Alpha", 0)]);
    expect(
      document.querySelector(".anarchy-leaderboard-label")?.textContent,
    ).toBe("Current leading faction: Alpha");
    store.applyDelta([], [1]);
    expect(
      document.querySelector(".anarchy-leaderboard-label")?.textContent,
    ).toBe("No factions yet");
    handle.unmount();
  });

  test("unmount tears down the DOM and stops responding to updates", () => {
    const store = new LeaderboardStore();
    const handle = mountLeaderboardHud({ store });
    handle.unmount();
    expect(document.getElementById("anarchy-leaderboard-hud")).toBeNull();
    // Subsequent applies must not throw.
    store.applySnapshot([entry(1, "Alpha", 0)]);
  });
});
