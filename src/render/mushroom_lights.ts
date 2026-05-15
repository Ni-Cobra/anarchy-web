/**
 * Per-mushroom point-light pool (task 140). Each placed `BlockType.LightMushroom`
 * cell contributes a small cool-toned point light in the world; intensity
 * scales with the night factor sampled from `daylight.ts` so mushroom patches
 * barely glow at noon and emit a soft cyan glow at midnight.
 *
 * Sized smaller than the torch pool — mushrooms are a "patch of ambient
 * decoration" rather than the player's primary light, so a pool of ~24 is
 * plenty in practice. Picks the nearest-N around the local player each
 * frame, same shape as `torch_lights.ts`.
 *
 * The colour deliberately sits in the blue-cyan range so a torch + a
 * mushroom patch read as distinct light sources side-by-side; the
 * radius / intensity envelope is ~50–60% of a torch's so mushrooms feel
 * like ambient atmosphere rather than a torch substitute (task 140 brief).
 */

import * as THREE from "three";

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** Active-point-light cap — beyond this many mushrooms in view the renderer
 *  starts dropping the dimmest. Smaller than the torch pool because a
 *  mushroom patch tends to cluster; 24 covers a decent cave/forest scene
 *  without exhausting WebGL's per-frame light slots when combined with the
 *  torch pool. */
export const MAX_MUSHROOM_LIGHTS = 24;

/** Soft cool-blue/teal tint — distinct from the torch's warm orange so a
 *  scene with both reads them as different light sources. Chosen against
 *  the lighter night ambient introduced by task 120 — the cyan stays
 *  visible against the brighter deep-blue night without bleeding into it. */
const MUSHROOM_LIGHT_COLOR = 0x9fd9ff;

/** Falloff radius — ~55% of a torch's `TORCH_LIGHT_DISTANCE` (10.0) so a
 *  mushroom lights two-to-three tiles around it. Forces a torch to still
 *  feel like the upgrade for serious lighting. */
const MUSHROOM_LIGHT_DISTANCE = 5.5;

/** Decay exponent. Same shape as the torch (`1.4`) — readable warm-bias
 *  falloff rather than physically-correct inverse-square. */
const MUSHROOM_LIGHT_DECAY = 1.4;

/** Peak intensity at midnight — ~55% of `TORCH_LIGHT_PEAK_INTENSITY` so a
 *  mushroom patch reads as ambient atmosphere rather than navigable light. */
const MUSHROOM_LIGHT_PEAK_INTENSITY = 1.65;

/** Y offset of the light — roughly at the mushroom cap so the cone reads as
 *  coming from the bloom, not the ground beneath it. */
const MUSHROOM_LIGHT_Y = 0.45;

/**
 * Build a mushroom-flavoured `THREE.PointLight`. Cool cyan tint + the
 * shared decay shape; callers pin `position` and `intensity` per use site.
 */
export function createMushroomLight(): THREE.PointLight {
  return new THREE.PointLight(
    MUSHROOM_LIGHT_COLOR,
    1.0,
    MUSHROOM_LIGHT_DISTANCE,
    MUSHROOM_LIGHT_DECAY,
  );
}

/**
 * Pool of `MAX_MUSHROOM_LIGHTS` reusable `THREE.PointLight` instances driven
 * by the per-chunk mushroom positions plumbed from `applyChunkLoaded` /
 * `applyChunkUnloaded`. The renderer calls `update()` once per frame with
 * the local player's scene-space focus and the current night factor; the
 * pool selects the `MAX_MUSHROOM_LIGHTS` nearest mushrooms and pins those
 * lights, hiding the rest. Mirrors `TorchLights` so future per-chunk
 * decorative-light additions can share the pattern.
 */
export class MushroomLights {
  private readonly group: THREE.Group;
  private readonly pool: THREE.PointLight[] = [];
  private readonly mushroomsByChunk = new Map<
    string,
    Array<{ x: number; z: number }>
  >();
  private readonly maxLights: number;
  private readonly scratch: Array<{ x: number; z: number; d2: number }> = [];

  constructor(maxLights: number = MAX_MUSHROOM_LIGHTS) {
    this.maxLights = maxLights;
    this.group = new THREE.Group();
    this.group.name = "mushroom-lights";
    for (let i = 0; i < maxLights; i++) {
      const light = createMushroomLight();
      light.visible = false;
      this.pool.push(light);
      this.group.add(light);
    }
  }

  /** The Three.js group the renderer adds to its scene. */
  scene(): THREE.Group {
    return this.group;
  }

  /**
   * Replace the cached set of mushroom positions for chunk `(cx, cy)`. The
   * renderer calls this on `applyChunkLoaded` after the chunk's mesh has
   * been rebuilt; passing an empty array is the same as `removeChunk`.
   */
  setChunkMushrooms(
    cx: number,
    cy: number,
    positions: ReadonlyArray<{ x: number; z: number }>,
  ): void {
    const key = chunkKey(cx, cy);
    if (positions.length === 0) {
      this.mushroomsByChunk.delete(key);
      return;
    }
    this.mushroomsByChunk.set(
      key,
      positions.map((p) => ({ x: p.x, z: p.z })),
    );
  }

  /** Drop chunk `(cx, cy)`'s mushroom positions — `applyChunkUnloaded`. */
  removeChunk(cx: number, cy: number): void {
    this.mushroomsByChunk.delete(chunkKey(cx, cy));
  }

  /**
   * Per-frame light update. Picks the `maxLights` mushrooms nearest `focus`
   * (scene XZ) and pins their pool lights at intensity scaled by
   * `nightFactor ∈ [0, 1]`. At noon every light hides; at midnight the
   * picked lights shine at `MUSHROOM_LIGHT_PEAK_INTENSITY`.
   */
  update(
    focus: { readonly x: number; readonly z: number },
    nightFactor: number,
  ): void {
    const clamped = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    if (clamped === 0) {
      for (const l of this.pool) l.visible = false;
      return;
    }
    this.scratch.length = 0;
    for (const list of this.mushroomsByChunk.values()) {
      for (const p of list) {
        const dx = p.x - focus.x;
        const dz = p.z - focus.z;
        this.scratch.push({ x: p.x, z: p.z, d2: dx * dx + dz * dz });
      }
    }
    this.scratch.sort((a, b) => a.d2 - b.d2);
    const take = Math.min(this.maxLights, this.scratch.length);
    const intensity = MUSHROOM_LIGHT_PEAK_INTENSITY * clamped;
    for (let i = 0; i < take; i++) {
      const light = this.pool[i];
      const p = this.scratch[i];
      light.position.set(p.x, MUSHROOM_LIGHT_Y, p.z);
      light.intensity = intensity;
      light.visible = true;
    }
    for (let i = take; i < this.pool.length; i++) {
      this.pool[i].visible = false;
    }
  }

  /** Detach every pooled light from the group. */
  dispose(): void {
    for (const light of this.pool) this.group.remove(light);
    this.pool.length = 0;
    this.mushroomsByChunk.clear();
  }

  /** Test-only: total mushrooms the layer is currently tracking across
   *  every chunk. */
  trackedMushroomCount(): number {
    let n = 0;
    for (const list of this.mushroomsByChunk.values()) n += list.length;
    return n;
  }

  /** Test-only: peak per-light intensity at the supplied night factor. */
  static intensityAt(nightFactor: number): number {
    const clamped = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    return MUSHROOM_LIGHT_PEAK_INTENSITY * clamped;
  }
}
