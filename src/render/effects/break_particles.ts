import * as THREE from "three";

import { BlockType } from "../../game/index.js";

/**
 * Cosmetic puff that fires the moment a top-layer cell breaks. The wire
 * layer already publishes per-tick `BlockEdit` events; the renderer routes
 * the `broken` ones here to give destruction a satisfying "thunk" — a few
 * short-lived sprites scatter outward from the cell, fall under gravity,
 * and fade.
 *
 * Pure client-side: no proto change, no server change. Color comes from a
 * caller-supplied [`BreakParticleColorLookup`] so the layer can be unit-
 * tested without standing up the texture set; the renderer hands in a
 * fixed palette keyed on `BlockType`.
 *
 * Particle motion is deterministic — eight quads emitted at fixed angles
 * around the cell, all with the same initial speed + lifetime — so tests
 * can pin position over `dt` without seeding an RNG. A global cap drops
 * the oldest particle when a server-driven mass break would otherwise
 * push the live count past `PARTICLE_CAP`.
 */
export type BreakParticleColorLookup = (kind: BlockType) => number;

const PARTICLES_PER_BREAK = 8;
const PARTICLE_LIFETIME_MS = 400;
const PARTICLE_SIZE = 0.14;
// World-space spawn height — middle of a unit cube sitting on the ground,
// matching `EffectsLayer`'s break-shatter anchor so the puff visually
// originates from where the block was.
const PARTICLE_SPAWN_Y = 0.5;
// Outward horizontal speed (tiles/sec). Each particle's XZ velocity is
// `cosθ * SPEED`, `sinθ * SPEED` for `θ = i * 2π / PARTICLES_PER_BREAK`.
const PARTICLE_SPEED_HORIZONTAL = 1.5;
// Initial upward velocity (tiles/sec). Combined with `PARTICLE_GRAVITY`
// the particles rise briefly then fall — the arc is what reads as a
// puff rather than a flat radial spray.
const PARTICLE_SPEED_VERTICAL = 1.5;
const PARTICLE_GRAVITY = 5;
const PARTICLE_OPACITY = 0.95;
const PARTICLE_CAP = 64;

interface Particle {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly geometry: THREE.BoxGeometry;
  readonly originX: number;
  readonly originZ: number;
  readonly velocityX: number;
  readonly velocityZ: number;
  readonly velocityY: number;
  readonly startMs: number;
  readonly endMs: number;
}

export class BreakParticles {
  private readonly group: THREE.Group;
  private readonly particles: Particle[] = [];

  constructor(private readonly colorFor: BreakParticleColorLookup) {
    this.group = new THREE.Group();
    this.group.name = "break-particles";
  }

  /** Scene root the renderer adds to its main scene at construction. */
  scene(): THREE.Object3D {
    return this.group;
  }

  /** Live particle count — exposed for tests + cap assertions. */
  count(): number {
    return this.particles.length;
  }

  /**
   * Fire one puff at `(sceneX, sceneZ)` tinted for the broken `kind`.
   * Particles are emitted at fixed angles so successive calls produce
   * the same pattern — the test suite leans on that determinism.
   */
  spawn(sceneX: number, sceneZ: number, kind: BlockType, nowMs: number): void {
    const tint = this.colorFor(kind);
    for (let i = 0; i < PARTICLES_PER_BREAK; i++) {
      if (this.particles.length >= PARTICLE_CAP) {
        // Drop oldest — the live array is FIFO so index 0 is the
        // earliest still-active particle.
        this.disposeAt(0);
      }
      const angle = (i / PARTICLES_PER_BREAK) * Math.PI * 2;
      const vx = Math.cos(angle) * PARTICLE_SPEED_HORIZONTAL;
      const vz = Math.sin(angle) * PARTICLE_SPEED_HORIZONTAL;
      const geometry = new THREE.BoxGeometry(
        PARTICLE_SIZE,
        PARTICLE_SIZE,
        PARTICLE_SIZE,
      );
      const material = new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: PARTICLE_OPACITY,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(sceneX, PARTICLE_SPAWN_Y, sceneZ);
      this.group.add(mesh);
      this.particles.push({
        mesh,
        material,
        geometry,
        originX: sceneX,
        originZ: sceneZ,
        velocityX: vx,
        velocityZ: vz,
        velocityY: PARTICLE_SPEED_VERTICAL,
        startMs: nowMs,
        endMs: nowMs + PARTICLE_LIFETIME_MS,
      });
    }
  }

  /**
   * Per-frame update from the renderer. Walks live particles,
   * integrates position + opacity from start time, and disposes any
   * past their lifetime.
   */
  update(nowMs: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (nowMs >= p.endMs) {
        this.disposeAt(i);
        continue;
      }
      const elapsedMs = nowMs - p.startMs;
      const dtSec = elapsedMs / 1000;
      const t = elapsedMs / PARTICLE_LIFETIME_MS;
      const x = p.originX + p.velocityX * dtSec;
      const z = p.originZ + p.velocityZ * dtSec;
      const y =
        PARTICLE_SPAWN_Y + p.velocityY * dtSec - 0.5 * PARTICLE_GRAVITY * dtSec * dtSec;
      p.mesh.position.set(x, y, z);
      p.material.opacity = PARTICLE_OPACITY * (1 - t);
    }
  }

  /** Drop every owned material / geometry. Called by the renderer on
   * `dispose()`. */
  dispose(): void {
    while (this.particles.length > 0) {
      this.disposeAt(this.particles.length - 1);
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }

  private disposeAt(idx: number): void {
    const p = this.particles[idx];
    this.group.remove(p.mesh);
    p.geometry.dispose();
    p.material.dispose();
    this.particles.splice(idx, 1);
  }
}

/**
 * Default per-`BlockType` tint applied to break particles. Mirrors the
 * task spec — Stone → gray, Gold → yellow, Tree → green, Sticks → brown,
 * Wood → light brown. Grass / Air fall back to a neutral mid-gray; in
 * practice the wire layer never breaks Grass or Air, so the fallback only
 * matters as defensive default for an unexpected `BlockType` value.
 */
export const DEFAULT_BREAK_PARTICLE_COLORS: Readonly<Record<BlockType, number>> = {
  [BlockType.Air]: 0x808080,
  [BlockType.Grass]: 0x4a8a3a,
  [BlockType.Wood]: 0xc7945a,
  [BlockType.Stone]: 0x8a8a8a,
  [BlockType.Gold]: 0xf5d042,
  [BlockType.Tree]: 0x3a8a3a,
  [BlockType.Sticks]: 0x6a4a2a,
  // Hidden never reaches the break / particle path — the server rejects
  // break attempts on hidden cells and the wire never carries Hidden in a
  // BlockEdit attribution. Kept here for the exhaustive-Record typecheck.
  [BlockType.Hidden]: 0x4d4d4d,
  [BlockType.FlowerRed]: 0xe03333,
  [BlockType.FlowerYellow]: 0xf6ce42,
  [BlockType.FlowerBlue]: 0x4a6ee0,
  [BlockType.FlowerWhite]: 0xf2f4f8,
  [BlockType.Bush]: 0x336a2a,
  [BlockType.Dirt]: 0x6b4729,
  [BlockType.Sand]: 0xe5ce96,
  [BlockType.Gravel]: 0x888276,
  [BlockType.StoneLight]: 0xa8aeb6,
  [BlockType.StoneDark]: 0x525255,
  [BlockType.CopperOre]: 0xc86e36,
  [BlockType.IronOre]: 0xb89070,
  [BlockType.TungstenOre]: 0x4d5560,
  [BlockType.CoalOre]: 0x18181a,
  [BlockType.DiamondOre]: 0x4ac2e5,
  // Task 350: a broken torch puffs warm flame-coloured shards.
  [BlockType.Torch]: 0xf6761a,
};

export function defaultBreakParticleColor(kind: BlockType): number {
  return DEFAULT_BREAK_PARTICLE_COLORS[kind] ?? 0x808080;
}
