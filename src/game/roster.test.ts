import { describe, expect, it, vi } from "vitest";

import { type Roster, RosterStore } from "./roster.js";

function rosterOf(...entries: Array<[number, string]>): Roster {
  return {
    entries: entries.map(([playerId, username]) => ({ playerId, username })),
    maxPlayers: 32,
  };
}

describe("RosterStore", () => {
  it("returns null before any apply", () => {
    const store = new RosterStore();
    expect(store.current()).toBeNull();
  });

  it("apply replaces the latest snapshot", () => {
    const store = new RosterStore();
    const first = rosterOf([1, "Alice"]);
    store.apply(first);
    expect(store.current()).toBe(first);

    const second = rosterOf([1, "Alice"], [2, "Bob"]);
    store.apply(second);
    expect(store.current()).toBe(second);
    expect(store.current()?.entries.length).toBe(2);
  });

  it("notifies subscribers on every apply", () => {
    const store = new RosterStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const a = rosterOf([1, "Anna"]);
    store.apply(a);
    const b = rosterOf([1, "Anna"], [2, "Bea"]);
    store.apply(b);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, a);
    expect(listener).toHaveBeenNthCalledWith(2, b);
  });

  it("fires subscribe synchronously with the current snapshot if one exists", () => {
    const store = new RosterStore();
    const r = rosterOf([7, "Tea"]);
    store.apply(r);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(r);
  });

  it("subscribe does NOT fire synchronously when there is no snapshot yet", () => {
    const store = new RosterStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe function that removes the listener", () => {
    const store = new RosterStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.apply(rosterOf([1, "X"]));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.apply(rosterOf([1, "X"], [2, "Y"]));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
