/**
 * Per-player lantern lights (task 370). Each player whose `equippedUtility`
 * is [`ItemId.Lantern`] gets a warm point light pinned at head height that
 * tracks their position. Intensity scales with the night factor sampled
 * from `daylight.ts`, mirroring the placed-torch behavior.
 *
 * Sized by visible-player count rather than capped — a session with a few
 * dozen players has roughly that many active lights at most, well under
 * the WebGL limit. The torch pool's nearest-N cap doesn't apply because
 * the lantern's audience is "every player wearing one in your view
 * window", not "every torch in the world".
 *
 * Reuses `createTorchLight()` from `torch_lights.ts` so the lantern shares
 * the torch's warm tint + decay; the lantern bumps `distance` slightly
 * (task 370 says "slightly larger radius than a torch — it's the upgrade")
 * and keeps the same peak intensity so the night-factor scale reads
 * consistent across both light kinds.
 */

import * as THREE from "three";

import { ItemId, type PlayerId } from "../game/index.js";
import { createTorchLight } from "./torch_lights.js";
import { tileToScene } from "./sync.js";

/** Y offset where the lantern light sits — roughly at the player's head
 *  so the warm cone reads as "coming from the lantern at the side", not
 *  the ground. */
const LANTERN_LIGHT_Y = 1.1;

/** Lantern peak intensity at midnight. Same scale as the torch so a
 *  player carrying one feels as bright as standing next to a placed
 *  torch — and so the day-night fade reads identically. */
const LANTERN_PEAK_INTENSITY = 1.5;

/** Distance multiplier on the shared torch falloff. The lantern lights
 *  ~5-6 tiles vs. the torch's ~3-4, matching "slightly larger radius
 *  than a torch — it's the upgrade" from task 370. The number is the
 *  raw `THREE.PointLight.distance`, not a scaling factor — it replaces
 *  whatever `createTorchLight()` set. */
const LANTERN_LIGHT_DISTANCE = 11.0;

/** One renderable entity with the fields this layer consumes. Subset of
 *  `RenderableEntity` so unit tests can build a minimal struct without
 *  pulling in the full mesh-sync entity shape. */
export interface LanternEntity {
  readonly id: PlayerId;
  readonly x: number;
  readonly y: number;
  readonly equippedUtility: ItemId | null;
}

/**
 * Pool of `THREE.PointLight` instances keyed by `PlayerId`. The renderer
 * calls `update()` each frame with the current entity list + night
 * factor; the pool inserts a new light for any player who started
 * wearing a lantern, removes lights for any who stopped, and pins
 * positions + intensity for the rest.
 */
export class LanternLights {
  private readonly group: THREE.Group;
  private readonly lights = new Map<PlayerId, THREE.PointLight>();

  constructor() {
    this.group = new THREE.Group();
    this.group.name = "lantern-lights";
  }

  /** The Three.js group the renderer adds to its scene. */
  scene(): THREE.Group {
    return this.group;
  }

  /**
   * Reconcile the pool against the current entity list and night factor.
   * Players wearing a lantern get a light (created on first sight,
   * repositioned on subsequent frames); players without one have their
   * light retired. At noon (`nightFactor == 0`) every light hides without
   * being torn down so a transient day → dusk → night cycle doesn't
   * thrash the scene graph.
   */
  update(
    entities: Iterable<LanternEntity>,
    nightFactor: number,
  ): void {
    const clamped = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    const intensity = LANTERN_PEAK_INTENSITY * clamped;
    const seen = new Set<PlayerId>();
    for (const e of entities) {
      if (e.equippedUtility !== ItemId.Lantern) continue;
      seen.add(e.id);
      let light = this.lights.get(e.id);
      if (!light) {
        light = createTorchLight();
        light.distance = LANTERN_LIGHT_DISTANCE;
        this.lights.set(e.id, light);
        this.group.add(light);
      }
      const scene = tileToScene(e.x, e.y);
      light.position.set(scene.x, LANTERN_LIGHT_Y, scene.z);
      light.intensity = intensity;
      light.visible = clamped > 0;
    }
    // Drop lights for players who stopped wearing a lantern (or whose
    // chunk left the view).
    for (const id of [...this.lights.keys()]) {
      if (seen.has(id)) continue;
      const light = this.lights.get(id)!;
      this.group.remove(light);
      this.lights.delete(id);
    }
  }

  /** Detach and forget every pooled light. Three.js point lights have no
   *  GPU resources beyond their parent reference, so this is enough to
   *  tear the layer down cleanly. */
  dispose(): void {
    for (const light of this.lights.values()) this.group.remove(light);
    this.lights.clear();
  }

  /** Test-only: number of lit, visible lights this pool currently shows. */
  visibleCount(): number {
    let n = 0;
    for (const light of this.lights.values()) {
      if (light.visible) n++;
    }
    return n;
  }

  /** Test-only: peak per-light intensity at the supplied night factor. */
  static intensityAt(nightFactor: number): number {
    const clamped = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    return LANTERN_PEAK_INTENSITY * clamped;
  }
}
