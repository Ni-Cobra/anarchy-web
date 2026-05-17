import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { paletteColorHex } from "../game/palette.js";
import {
  SLASH_BODY_Y,
  SLASH_END_SCALE,
  SLASH_LIFETIME_MS,
  SlashLayer,
  shouldSpawnSlashFor,
  shouldTriggerAttackerShake,
  slashAlphaAt,
  slashScaleAt,
} from "./slash_layer.js";

describe("shouldSpawnSlashFor", () => {
  it("returns false for charge-started (beam handles the charge visual)", () => {
    expect(shouldSpawnSlashFor("charge-started")).toBe(false);
  });
  it("returns true for strike-hit (every successful strike flashes)", () => {
    expect(shouldSpawnSlashFor("strike-hit")).toBe(true);
  });
  it("returns true for strike-missed (the empty-swing animation)", () => {
    expect(shouldSpawnSlashFor("strike-missed")).toBe(true);
  });
});

describe("shouldTriggerAttackerShake", () => {
  it("fires for the local player on strike-hit", () => {
    expect(shouldTriggerAttackerShake("strike-hit", 42, 42)).toBe(true);
  });
  it("fires for the local player on strike-missed", () => {
    expect(shouldTriggerAttackerShake("strike-missed", 42, 42)).toBe(true);
  });
  it("does NOT fire on charge-started", () => {
    expect(shouldTriggerAttackerShake("charge-started", 42, 42)).toBe(false);
  });
  it("does NOT fire when a remote player is the attacker", () => {
    expect(shouldTriggerAttackerShake("strike-hit", 99, 42)).toBe(false);
    expect(shouldTriggerAttackerShake("strike-missed", 99, 42)).toBe(false);
  });
  it("does NOT fire when there is no local player", () => {
    expect(shouldTriggerAttackerShake("strike-hit", 42, null)).toBe(false);
  });
});

describe("slashAlphaAt", () => {
  it("is 1 at t = 0", () => {
    expect(slashAlphaAt(0)).toBe(1);
  });
  it("is 0 at t = SLASH_LIFETIME_MS", () => {
    expect(slashAlphaAt(SLASH_LIFETIME_MS)).toBe(0);
  });
  it("clamps negative elapsed to 1", () => {
    expect(slashAlphaAt(-50)).toBe(1);
  });
  it("clamps elapsed past the lifetime to 0", () => {
    expect(slashAlphaAt(SLASH_LIFETIME_MS + 100)).toBe(0);
  });
  it("lerps linearly between 1 and 0", () => {
    const half = slashAlphaAt(SLASH_LIFETIME_MS / 2);
    expect(Math.abs(half - 0.5)).toBeLessThan(1e-9);
  });
});

describe("slashScaleAt", () => {
  it("is 1 at t = 0", () => {
    expect(slashScaleAt(0)).toBe(1);
  });
  it("is SLASH_END_SCALE at t = SLASH_LIFETIME_MS", () => {
    expect(slashScaleAt(SLASH_LIFETIME_MS)).toBe(SLASH_END_SCALE);
  });
  it("expands monotonically across the lifetime", () => {
    let prev = slashScaleAt(0);
    for (let i = 1; i <= 10; i++) {
      const t = (i / 10) * SLASH_LIFETIME_MS;
      const cur = slashScaleAt(t);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe("SlashLayer", () => {
  function baseInput() {
    return {
      attackerPlayerId: 1,
      attackerColorIndex: 0,
      anchor: { x: 4, y: 5 },
      direction: { x: 1, y: 0 },
      nowMs: 1_000,
    };
  }

  it("starts empty", () => {
    const layer = new SlashLayer();
    expect(layer.size()).toBe(0);
    layer.dispose();
  });

  it("spawn adds a mesh and size() reflects the active count", () => {
    const layer = new SlashLayer();
    layer.spawn(baseInput());
    expect(layer.size()).toBe(1);
    expect(layer.group.children.length).toBe(1);
    layer.dispose();
  });

  it("tints the slash by the attacker's palette colour", () => {
    const layer = new SlashLayer();
    layer.spawn({ ...baseInput(), attackerColorIndex: 3 });
    expect(layer.slashColorHexAt(0)).toBe(paletteColorHex(3));
    layer.dispose();
  });

  it("anchors the slash at the target's tile centre on STRIKE_HIT", () => {
    const layer = new SlashLayer();
    // Caller (renderer) hands in the target's tile centre as `anchor`.
    layer.spawn({ ...baseInput(), anchor: { x: 4.5, y: 5.5 } });
    const pos = layer.slashPositionAt(0);
    expect(pos).not.toBeNull();
    expect(pos!.x).toBeCloseTo(4.5, 6);
    expect(pos!.y).toBeCloseTo(SLASH_BODY_Y, 6);
    // World y maps to scene -z.
    expect(pos!.z).toBeCloseTo(-5.5, 6);
    layer.dispose();
  });

  it("anchors the slash at the attacker's post-dash position on STRIKE_MISSED with no surviving target", () => {
    const layer = new SlashLayer();
    // Renderer passes the attacker's authoritative landing tile as
    // `anchor` when the target is gone.
    layer.spawn({
      attackerPlayerId: 7,
      attackerColorIndex: 0,
      anchor: { x: 2.0, y: 0.5 },
      direction: { x: 1, y: 0 },
      nowMs: 0,
    });
    const pos = layer.slashPositionAt(0);
    expect(pos).not.toBeNull();
    expect(pos!.x).toBeCloseTo(2.0, 6);
    expect(pos!.z).toBeCloseTo(-0.5, 6);
    layer.dispose();
  });

  it("retires the slash exactly at spawnMs + SLASH_LIFETIME_MS", () => {
    const layer = new SlashLayer();
    layer.spawn(baseInput());
    // One tick just inside the window — slash still live.
    layer.tick(1_000 + SLASH_LIFETIME_MS - 1);
    expect(layer.size()).toBe(1);
    // One tick at the boundary — slash retires.
    layer.tick(1_000 + SLASH_LIFETIME_MS);
    expect(layer.size()).toBe(0);
    layer.dispose();
  });

  it("fades and expands across the lifetime", () => {
    const layer = new SlashLayer();
    layer.spawn(baseInput());
    layer.tick(1_000);
    expect(layer.slashAlphaAt(0)).toBeCloseTo(1, 6);
    expect(layer.slashScaleAt(0)).toBeCloseTo(1, 6);
    layer.tick(1_000 + SLASH_LIFETIME_MS / 2);
    expect(layer.slashAlphaAt(0)!).toBeLessThan(1);
    expect(layer.slashAlphaAt(0)!).toBeGreaterThan(0);
    expect(layer.slashScaleAt(0)!).toBeGreaterThan(1);
    expect(layer.slashScaleAt(0)!).toBeLessThan(SLASH_END_SCALE);
    layer.dispose();
  });

  it("multiple overlapping slashes coexist", () => {
    const layer = new SlashLayer();
    layer.spawn({ ...baseInput(), attackerPlayerId: 1, attackerColorIndex: 0 });
    layer.spawn({ ...baseInput(), attackerPlayerId: 2, attackerColorIndex: 4 });
    layer.spawn({ ...baseInput(), attackerPlayerId: 3, attackerColorIndex: 1 });
    expect(layer.size()).toBe(3);
    expect(layer.slashAttackerAt(0)).toBe(1);
    expect(layer.slashAttackerAt(1)).toBe(2);
    expect(layer.slashAttackerAt(2)).toBe(3);
    expect(layer.slashColorHexAt(1)).toBe(paletteColorHex(4));
    layer.dispose();
  });

  it("retires only the expired slash when overlapping spawns have different start times", () => {
    const layer = new SlashLayer();
    layer.spawn({ ...baseInput(), attackerPlayerId: 1, nowMs: 1_000 });
    layer.spawn({ ...baseInput(), attackerPlayerId: 2, nowMs: 1_200 });
    expect(layer.size()).toBe(2);
    // At t = 1_250: first slash is 250ms in (expired); second is 50ms in.
    layer.tick(1_250);
    expect(layer.size()).toBe(1);
    expect(layer.slashAttackerAt(0)).toBe(2);
    layer.dispose();
  });

  it("clearAll drops every slash and does not break subsequent spawns", () => {
    const layer = new SlashLayer();
    layer.spawn(baseInput());
    layer.spawn({ ...baseInput(), attackerPlayerId: 2 });
    expect(layer.size()).toBe(2);
    layer.clearAll();
    expect(layer.size()).toBe(0);
    layer.spawn({ ...baseInput(), attackerPlayerId: 3, nowMs: 2_000 });
    expect(layer.size()).toBe(1);
    expect(layer.slashAttackerAt(0)).toBe(3);
    layer.dispose();
  });

  it("orients the quad in the ground plane with the normal pointing up", () => {
    const layer = new SlashLayer();
    layer.spawn(baseInput());
    const child = layer.group.children[0] as THREE.Mesh;
    // The default PlaneGeometry normal is +Z; after the layer's
    // orientation the world-space normal should sit along +Y so the
    // sprite reads top-down with the rest of the ground-plane visuals.
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(child.quaternion);
    expect(Math.abs(normal.y)).toBeGreaterThan(0.99);
    layer.dispose();
  });
});
