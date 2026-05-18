import { describe, expect, test, vi } from "vitest";

import {
  type FactionEntry,
  LeaderboardStore,
  currentLeader,
  sortedByXpDesc,
} from "./leaderboard.js";

function entry(
  id: number,
  name: string,
  xp: number,
  colorIndex = 0,
): FactionEntry {
  return {
    id,
    name,
    xp,
    flagChunk: [0, 0],
    flagLocal: [0, 0],
    colorIndex,
  };
}

describe("LeaderboardStore", () => {
  test("applySnapshot seeds the map and notifies subscribers", () => {
    const store = new LeaderboardStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.applySnapshot([entry(1, "Alpha", 0), entry(2, "Bravo", 5)]);
    expect(store.current().size).toBe(2);
    expect(store.current().get(1)?.name).toBe("Alpha");
    expect(store.current().get(2)?.xp).toBe(5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("applyDelta upserts new entries", () => {
    const store = new LeaderboardStore();
    store.applySnapshot([]);
    store.applyDelta([entry(7, "Charlie", 0)], []);
    expect(store.current().get(7)?.name).toBe("Charlie");
  });

  test("applyDelta replaces an existing entry (xp mutation)", () => {
    const store = new LeaderboardStore();
    store.applySnapshot([entry(1, "Alpha", 0)]);
    store.applyDelta([entry(1, "Alpha", 42)], []);
    expect(store.current().get(1)?.xp).toBe(42);
  });

  test("applyDelta removes by id", () => {
    const store = new LeaderboardStore();
    store.applySnapshot([entry(1, "Alpha", 0), entry(2, "Bravo", 5)]);
    store.applyDelta([], [1]);
    expect(store.current().has(1)).toBe(false);
    expect(store.current().has(2)).toBe(true);
  });

  test("subscribe replays the latest snapshot when present", () => {
    const store = new LeaderboardStore();
    store.applySnapshot([entry(1, "Alpha", 0)]);
    const fn = vi.fn();
    store.subscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("subscribe stays silent before any snapshot", () => {
    const store = new LeaderboardStore();
    const fn = vi.fn();
    store.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  test("unsubscribe stops notifications", () => {
    const store = new LeaderboardStore();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.applySnapshot([]);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.applyDelta([entry(1, "X", 0)], []);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("currentLeader", () => {
  test("returns null when the map is empty", () => {
    expect(currentLeader(new Map())).toBeNull();
  });

  test("picks the highest xp", () => {
    const map = new Map<number, FactionEntry>([
      [1, entry(1, "Alpha", 5)],
      [2, entry(2, "Bravo", 10)],
      [3, entry(3, "Charlie", 3)],
    ]);
    expect(currentLeader(map)?.name).toBe("Bravo");
  });

  test("ties break by lowest id", () => {
    const map = new Map<number, FactionEntry>([
      [5, entry(5, "Late", 7)],
      [2, entry(2, "Early", 7)],
    ]);
    expect(currentLeader(map)?.id).toBe(2);
  });
});

describe("sortedByXpDesc", () => {
  test("sorts by xp descending, then by id ascending", () => {
    const map = new Map<number, FactionEntry>([
      [5, entry(5, "E", 0)],
      [2, entry(2, "B", 10)],
      [1, entry(1, "A", 10)],
      [3, entry(3, "C", 5)],
    ]);
    const sorted = sortedByXpDesc(map);
    expect(sorted.map((e) => e.id)).toEqual([1, 2, 3, 5]);
  });
});
