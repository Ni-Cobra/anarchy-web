import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { BlockType } from "../../game/index.js";
import { BreakParticles } from "./break_particles.js";

/**
 * Pure-logic coverage for the break-puff emitter. The emitter wraps
 * Three.js objects but the lifecycle (spawn count, lifetime expiry,
 * gravity-shaped position over `dt`, global cap) is testable in jsdom
 * — meshes get created, position vectors mutate, no WebGL context
 * needed. The visual side (texture, material, depth bias) is left to
 * the in-browser dev confirmation.
 */
function makeEmitter(): BreakParticles {
  return new BreakParticles(() => 0xff00ff);
}

const PARTICLES_PER_BREAK = 8;
const PARTICLE_LIFETIME_MS = 400;
const PARTICLE_CAP = 64;
const SPAWN_Y = 0.5;

describe("BreakParticles", () => {
  it("spawns a fixed number of particles per break", () => {
    const e = makeEmitter();
    expect(e.count()).toBe(0);
    e.spawn(0, 0, BlockType.Stone, 0);
    expect(e.count()).toBe(PARTICLES_PER_BREAK);
  });

  it("expires every particle once the lifetime elapses", () => {
    const e = makeEmitter();
    e.spawn(0, 0, BlockType.Stone, 1_000);
    expect(e.count()).toBe(PARTICLES_PER_BREAK);
    // Mid-lifetime: still alive.
    e.update(1_000 + PARTICLE_LIFETIME_MS / 2);
    expect(e.count()).toBe(PARTICLES_PER_BREAK);
    // Past the end: every particle disposes.
    e.update(1_000 + PARTICLE_LIFETIME_MS + 1);
    expect(e.count()).toBe(0);
  });

  it("translates particles outward and applies gravity over dt", () => {
    const e = makeEmitter();
    // Spawn at scene origin so position-after-update reads back as
    // pure displacement.
    e.spawn(0, 0, BlockType.Stone, 0);
    const children = e.scene().children;
    expect(children).toHaveLength(PARTICLES_PER_BREAK);
    // Snapshot positions at t=0: every particle starts at the spawn point.
    for (const c of children) {
      expect(c.position.x).toBeCloseTo(0, 6);
      expect(c.position.z).toBeCloseTo(0, 6);
      expect(c.position.y).toBeCloseTo(SPAWN_Y, 6);
    }
    // Advance 100ms. Per the emitter's deterministic angles
    // (i * 2π / 8), the particle at i=0 moves along +x at the
    // configured horizontal speed (1.5 tiles/sec) → +0.15 tiles in
    // 0.1s. The particle at i=2 moves along +z at the same speed.
    e.update(100);
    // Both should still be alive.
    expect(e.count()).toBe(PARTICLES_PER_BREAK);
    const c0 = children[0];
    expect(c0.position.x).toBeCloseTo(0.15, 5);
    expect(c0.position.z).toBeCloseTo(0, 5);
    // Vertical: starts with v_y = 1.5 tiles/sec, gravity 5 tiles/sec².
    // y(t) = SPAWN_Y + 1.5*t - 0.5*5*t² → at t=0.1: 0.5 + 0.15 - 0.025 = 0.625.
    expect(c0.position.y).toBeCloseTo(0.625, 5);
    // Particle at angle π/2 (i=2) moves along +z.
    const c2 = children[2];
    expect(c2.position.x).toBeCloseTo(0, 5);
    expect(c2.position.z).toBeCloseTo(0.15, 5);
  });

  it("fades opacity linearly from full to zero over the lifetime", () => {
    const e = makeEmitter();
    e.spawn(0, 0, BlockType.Stone, 0);
    const matInitial = (e.scene().children[0] as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    const initial = matInitial.opacity;
    e.update(PARTICLE_LIFETIME_MS / 2);
    const matHalf = (e.scene().children[0] as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    expect(matHalf.opacity).toBeCloseTo(initial * 0.5, 4);
  });

  it("caps the live particle count by dropping the oldest", () => {
    const e = makeEmitter();
    // Eight bursts at t=0 = 64 particles, exactly at the cap.
    for (let i = 0; i < 8; i++) e.spawn(i, 0, BlockType.Stone, 0);
    expect(e.count()).toBe(PARTICLE_CAP);
    // One more burst at t=0 would push us to 72 — the cap should bite,
    // disposing the oldest particles (those spawned in the first burst)
    // so the live count stays at PARTICLE_CAP.
    e.spawn(99, 0, BlockType.Stone, 0);
    expect(e.count()).toBe(PARTICLE_CAP);
    // Also: bursting twice past the cap still respects it.
    e.spawn(100, 0, BlockType.Stone, 0);
    expect(e.count()).toBe(PARTICLE_CAP);
  });

  it("applies the per-kind tint via the supplied lookup", () => {
    const seen: BlockType[] = [];
    const e = new BreakParticles((kind) => {
      seen.push(kind);
      return 0x123456;
    });
    e.spawn(0, 0, BlockType.Gold, 0);
    expect(seen).toEqual([BlockType.Gold]);
    const mat = (e.scene().children[0] as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    expect(mat.color.getHex()).toBe(0x123456);
  });

  it("clears all owned scene state on dispose", () => {
    const e = makeEmitter();
    e.spawn(0, 0, BlockType.Stone, 0);
    e.spawn(2, 2, BlockType.Tree, 100);
    expect(e.count()).toBe(PARTICLES_PER_BREAK * 2);
    e.dispose();
    expect(e.count()).toBe(0);
    expect(e.scene().children).toHaveLength(0);
  });
});
