/**
 * Per-torch point-light pool (task 350). Each placed `BlockType.Torch` cell
 * contributes a small warm point light in the world; intensity scales with
 * the night factor sampled from `daylight.ts` so torches barely glow at
 * noon and shine at midnight.
 *
 * The pool is fixed-size (`MAX_LIGHTS`) and the `update()` step picks the
 * `MAX_LIGHTS` nearest torches around the local player each frame — far
 * enough away from the player you can't see them anyway, and capping the
 * active-light count keeps the WebGL renderer happy.
 *
 * `createTorchLight()` is shared with the lantern (task 370) so both
 * placed-light and player-attached light sources have the same warm
 * appearance.
 */

import * as THREE from "three";

/** Key for the per-chunk torch map. Local to this module — `net/`'s
 *  `coordKey` lives across the module-boundary line and the renderer
 *  shouldn't reach into it. */
function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** Active-point-light cap — beyond this many torches in view the renderer
 *  starts dropping the dimmest. */
export const MAX_TORCH_LIGHTS = 32;

/** Warm flame tint shared with the lantern (task 370). */
const TORCH_LIGHT_COLOR = 0xffaa55;

/** Falloff radius. A torch lights ~4-5 tiles around it at midnight, fading
 *  past that — far enough to navigate by, close enough that 32 of them in
 *  view don't paint everything orange. Bumped from 8.0 alongside the
 *  intensity doubling (task 450) so the brighter source spreads to a
 *  larger pool rather than read as a tiny over-bright dot. */
const TORCH_LIGHT_DISTANCE = 10.0;

/** Decay exponent. Higher = sharper falloff. `2` is physically correct
 *  inverse-square; `1.4` reads warmer in the test scene without nuking the
 *  near-tile contribution to almost-imperceptible. */
const TORCH_LIGHT_DECAY = 1.4;

/** Peak intensity (at midnight, where `nightFactor == 1`). Doubled to
 *  ~3.0 (task 450) so a single torch reads obviously bright against the
 *  night ambient floor; paired with a slightly larger `TORCH_LIGHT_DISTANCE`
 *  to spread the extra energy rather than concentrate it at the center. */
const TORCH_LIGHT_PEAK_INTENSITY = 3.0;

/** Y offset where the per-torch light sits — roughly at the top of the
 *  painted flame so the cone reads as "coming from the flame", not the
 *  ground. */
const TORCH_LIGHT_Y = 0.9;

/**
 * Build a torch-flavoured `THREE.PointLight`. Same warm tint + decay used
 * by both the placed torch (task 350) and the player-attached lantern
 * (task 370). Callers pin the `position` and `intensity` per use site.
 */
export function createTorchLight(): THREE.PointLight {
  return new THREE.PointLight(
    TORCH_LIGHT_COLOR,
    1.0,
    TORCH_LIGHT_DISTANCE,
    TORCH_LIGHT_DECAY,
  );
}

/**
 * Pool of `MAX_TORCH_LIGHTS` reusable `THREE.PointLight` instances driven
 * by the per-chunk torch positions plumbed from `applyChunkLoaded` /
 * `applyChunkUnloaded`. The renderer calls `update()` once per frame with
 * the local player's scene-space focus and the current night factor; the
 * pool selects the `MAX_TORCH_LIGHTS` nearest torches and pins those
 * lights, hiding the rest.
 */
export class TorchLights {
  private readonly group: THREE.Group;
  private readonly pool: THREE.PointLight[] = [];
  private readonly torchesByChunk = new Map<string, Array<{ x: number; z: number }>>();
  private readonly maxLights: number;
  // Scratch list reused across frames so the per-frame distance computation
  // doesn't allocate when the world is mostly stable. Trimmed back to the
  // current torch count each call, but the underlying array storage stays.
  private readonly scratch: Array<{ x: number; z: number; d2: number }> = [];

  constructor(maxLights: number = MAX_TORCH_LIGHTS) {
    this.maxLights = maxLights;
    this.group = new THREE.Group();
    this.group.name = "torch-lights";
    for (let i = 0; i < maxLights; i++) {
      const light = createTorchLight();
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
   * Replace the cached set of torch positions for chunk `(cx, cy)`. The
   * renderer calls this on `applyChunkLoaded` after the chunk's mesh has
   * been rebuilt; passing an empty array is the same as `removeChunk`.
   */
  setChunkTorches(
    cx: number,
    cy: number,
    positions: ReadonlyArray<{ x: number; z: number }>,
  ): void {
    const key = chunkKey(cx, cy);
    if (positions.length === 0) {
      this.torchesByChunk.delete(key);
      return;
    }
    this.torchesByChunk.set(key, positions.map((p) => ({ x: p.x, z: p.z })));
  }

  /** Drop chunk `(cx, cy)`'s torch positions — called on `applyChunkUnloaded`. */
  removeChunk(cx: number, cy: number): void {
    this.torchesByChunk.delete(chunkKey(cx, cy));
  }

  /**
   * Per-frame light update. Picks the `maxLights` torches nearest `focus`
   * (scene XZ) and pins their pool lights at intensity scaled by
   * `nightFactor ∈ [0, 1]`. At noon (`nightFactor == 0`) every light is
   * hidden; at midnight (`nightFactor == 1`) the picked lights shine at
   * `TORCH_LIGHT_PEAK_INTENSITY`. Spare pool slots stay invisible until
   * the picked count grows.
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
    for (const list of this.torchesByChunk.values()) {
      for (const p of list) {
        const dx = p.x - focus.x;
        const dz = p.z - focus.z;
        this.scratch.push({ x: p.x, z: p.z, d2: dx * dx + dz * dz });
      }
    }
    this.scratch.sort((a, b) => a.d2 - b.d2);
    const take = Math.min(this.maxLights, this.scratch.length);
    const intensity = TORCH_LIGHT_PEAK_INTENSITY * clamped;
    for (let i = 0; i < take; i++) {
      const light = this.pool[i];
      const p = this.scratch[i];
      light.position.set(p.x, TORCH_LIGHT_Y, p.z);
      light.intensity = intensity;
      light.visible = true;
    }
    for (let i = take; i < this.pool.length; i++) {
      this.pool[i].visible = false;
    }
  }

  /** Detach every pooled light from the group. Three.js point lights have
   *  no GPU resources to release beyond the parent's reference, so this is
   *  enough to tear the layer down without leaks. */
  dispose(): void {
    for (const light of this.pool) this.group.remove(light);
    this.pool.length = 0;
    this.torchesByChunk.clear();
  }

  /** Test-only: total number of torches the layer is currently tracking
   *  across every chunk. Useful for asserting `applyChunkLoaded` /
   *  `applyChunkUnloaded` plumbing without poking at private state. */
  trackedTorchCount(): number {
    let n = 0;
    for (const list of this.torchesByChunk.values()) n += list.length;
    return n;
  }

  /** Test-only: peak per-light intensity at the supplied night factor. */
  static intensityAt(nightFactor: number): number {
    const clamped = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    return TORCH_LIGHT_PEAK_INTENSITY * clamped;
  }
}
