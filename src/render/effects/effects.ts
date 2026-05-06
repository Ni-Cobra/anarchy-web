import * as THREE from "three";

import { paletteColorHex } from "../../game/index.js";
import { tileCenterToScene } from "../terrain.js";

/**
 * Per-edit / per-target events fed to [`EffectsLayer`] from the wire bridge.
 * The `BlockEditEvent` shape mirrors the server's `BlockEditEvent` (task
 * 070) — kind + cell + the *involved* top-layer block kind so the visual
 * can specialize (different shatter for trees, etc., as the renderer wants
 * to grow them). Today the layer is intentionally simple: every place
 * pulses, every break shatters, both tinted by the actor's color.
 */
export type BlockEditKind = "placed" | "broken";

export interface BlockEditEvent {
  readonly playerId: number;
  readonly kind: BlockEditKind;
  readonly cx: number;
  readonly cy: number;
  readonly lx: number;
  readonly ly: number;
}

export interface TargetingStateEvent {
  readonly playerId: number;
  readonly cx: number;
  readonly cy: number;
  readonly lx: number;
  readonly ly: number;
  /** `0..=100`. */
  readonly durabilityPct: number;
}

/**
 * Resolve a `playerId` to a palette color index. Closure rather than a
 * direct `World` reference so the effects layer doesn't import `../game`
 * for anything beyond palette helpers (which are pure data) — and so tests
 * can pin colors without standing up a real `World`. Returns `null` if the
 * player is unknown; the layer falls back to the default palette color.
 */
export type EffectsColorLookup = (playerId: number) => number | null;

// Animation durations (ms). The pulse / shatter both auto-expire when the
// renderer's per-frame `update(nowMs)` walks past their end timestamp.
const PLACE_PULSE_DURATION_MS = 250;
const BREAK_SHATTER_DURATION_MS = 350;
// Maximum scale a place pulse reaches before fading. Mirrors the
// targeting-overlay border so the pulse reads as "fence around the new
// block" rather than competing with the block's own footprint.
const PLACE_PULSE_MAX_SCALE = 1.45;
const PLACE_PULSE_OPACITY = 0.85;
// Shatter shrinks from full-cell to nothing while fading. Tuned so the
// effect is unmistakable but doesn't linger past the next tick.
const BREAK_SHATTER_MIN_SCALE = 0.2;
const BREAK_SHATTER_OPACITY = 0.9;
// Targeting frame: faint outlined cube tinted by the targeting player's
// color. Slightly inset from the cell so a stack of overlays from
// different players reads as concentric, not coincident.
const TARGETING_FRAME_SIZE = 1.05;
const TARGETING_FRAME_OPACITY = 0.85;
const TARGETING_FRAME_LIFT = 0.55;
// Durability bar — width tracks the pct, height + lift are static.
const DURABILITY_BAR_MAX_WIDTH = 0.9;
const DURABILITY_BAR_HEIGHT = 0.08;
const DURABILITY_BAR_THICKNESS = 0.04;
const DURABILITY_BAR_LIFT = 1.15;
const DURABILITY_BAR_BG_COLOR = 0x202020;
const DURABILITY_BAR_FILL_COLOR = 0xf5f5f5;

const TILE_TOP_Y = 0.04;

interface TimedEffect {
  readonly startMs: number;
  readonly endMs: number;
}

interface PlacePulse extends TimedEffect {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
}

interface BreakShatter extends TimedEffect {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
}

interface TargetingOverlay {
  readonly group: THREE.Group;
  readonly frame: THREE.LineSegments;
  readonly frameMaterial: THREE.LineBasicMaterial;
  readonly barFill: THREE.Mesh;
  readonly barFillMaterial: THREE.MeshBasicMaterial;
  readonly barBg: THREE.Mesh;
  readonly barBgMaterial: THREE.MeshBasicMaterial;
  /** Last-known durability pct so frame-rebuilds skip redundant scale work. */
  lastPct: number;
}

/**
 * The renderer's effects sub-layer (task 070): place pulses, break
 * shatters, and held-break targeting overlays. The layer owns its scene
 * group and a tiny per-effect lifecycle: events come in via
 * `onBlockEdit` / `applyTargets`, time advances via `update(nowMs)` from
 * the renderer's per-frame loop, expired effects dispose themselves.
 *
 * Per the task spec the layer never touches `window` / `document`, has no
 * timers, and bounds its allocation footprint by effect duration (place /
 * break) or the connected-player set (targeting). The renderer parents
 * the group; the layer's `dispose()` releases every owned material /
 * geometry on session end.
 */
export class EffectsLayer {
  private readonly group: THREE.Group;
  private readonly placePulses: PlacePulse[] = [];
  private readonly breakShatters: BreakShatter[] = [];
  // Targeting overlays are keyed by `playerId` — at most one held-break
  // target per player per tick (server enforces). A re-target replaces in
  // place; absence in `applyTargets(...)` removes the overlay.
  private readonly targetingByPlayer = new Map<number, TargetingOverlay>();

  constructor(private readonly colorLookup: EffectsColorLookup) {
    this.group = new THREE.Group();
    this.group.name = "effects";
  }

  /** Scene root the renderer adds to its main scene at construction. */
  scene(): THREE.Object3D {
    return this.group;
  }

  /**
   * Spawn a one-shot place pulse or break shatter for `event`. Tinted by
   * the player's lobby color (palette index 0 fallback if the player is
   * unknown to the local snapshot — should be rare; the wire layer lands
   * the chunk's player set in the same tick as the edit).
   */
  onBlockEdit(event: BlockEditEvent, nowMs: number): void {
    const tint = this.colorForPlayer(event.playerId);
    const center = tileCenterToScene(event.cx, event.cy, event.lx, event.ly);
    if (event.kind === "placed") {
      this.spawnPlacePulse(center.x, center.z, tint, nowMs);
    } else {
      this.spawnBreakShatter(center.x, center.z, tint, nowMs);
    }
  }

  /**
   * Replace the active targeting set wholesale. Entries that disappear
   * since the last call are torn down (player released / re-targeted /
   * the block broke). Entries that appear are spawned. Entries that
   * remain have their durability bar updated in place.
   */
  applyTargets(targets: readonly TargetingStateEvent[]): void {
    const live = new Set<number>();
    for (const t of targets) {
      live.add(t.playerId);
      this.upsertTargeting(t);
    }
    // Tear down any targeting overlay that didn't show up in the new set.
    const stale: number[] = [];
    for (const playerId of this.targetingByPlayer.keys()) {
      if (!live.has(playerId)) stale.push(playerId);
    }
    for (const playerId of stale) {
      this.disposeTargeting(playerId);
    }
  }

  /**
   * Per-frame update from the renderer. Walks the live pulses / shatters
   * and either advances their per-frame transform or disposes them past
   * their end. Targeting overlays don't time out — they live for as long
   * as the server keeps shipping the player's `TargetingState`.
   */
  update(nowMs: number): void {
    for (let i = this.placePulses.length - 1; i >= 0; i--) {
      const pulse = this.placePulses[i];
      const t = (nowMs - pulse.startMs) / (pulse.endMs - pulse.startMs);
      if (t >= 1) {
        this.disposePulse(pulse);
        this.placePulses.splice(i, 1);
        continue;
      }
      const scale = 1 + (PLACE_PULSE_MAX_SCALE - 1) * t;
      pulse.mesh.scale.set(scale, 1, scale);
      pulse.material.opacity = PLACE_PULSE_OPACITY * (1 - t);
    }
    for (let i = this.breakShatters.length - 1; i >= 0; i--) {
      const shatter = this.breakShatters[i];
      const t = (nowMs - shatter.startMs) / (shatter.endMs - shatter.startMs);
      if (t >= 1) {
        this.disposeShatter(shatter);
        this.breakShatters.splice(i, 1);
        continue;
      }
      const scale = 1 - (1 - BREAK_SHATTER_MIN_SCALE) * t;
      shatter.mesh.scale.setScalar(scale);
      shatter.material.opacity = BREAK_SHATTER_OPACITY * (1 - t);
    }
  }

  /** Drop every owned material / geometry. Called by the renderer on
   * `dispose()`. */
  dispose(): void {
    for (const pulse of this.placePulses) this.disposePulse(pulse);
    this.placePulses.length = 0;
    for (const shatter of this.breakShatters) this.disposeShatter(shatter);
    this.breakShatters.length = 0;
    for (const playerId of Array.from(this.targetingByPlayer.keys())) {
      this.disposeTargeting(playerId);
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }

  private colorForPlayer(playerId: number): number {
    const idx = this.colorLookup(playerId);
    return paletteColorHex(idx ?? 0);
  }

  private spawnPlacePulse(
    sceneX: number,
    sceneZ: number,
    tint: number,
    nowMs: number,
  ): void {
    // Thin flat ring on the ground that pulses outward — implemented as
    // an overscaled flat plane with a transparent material. The plane
    // pulses up from scale 1 → PLACE_PULSE_MAX_SCALE while fading.
    const geom = new THREE.BoxGeometry(1, 0.05, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: PLACE_PULSE_OPACITY,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(sceneX, TILE_TOP_Y, sceneZ);
    this.group.add(mesh);
    this.placePulses.push({
      mesh,
      material: mat,
      startMs: nowMs,
      endMs: nowMs + PLACE_PULSE_DURATION_MS,
    });
  }

  private spawnBreakShatter(
    sceneX: number,
    sceneZ: number,
    tint: number,
    nowMs: number,
  ): void {
    // Cube that shrinks + fades — same world position the broken block
    // occupied, so the eye stays put.
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: BREAK_SHATTER_OPACITY,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(sceneX, 0.55, sceneZ);
    this.group.add(mesh);
    this.breakShatters.push({
      mesh,
      material: mat,
      startMs: nowMs,
      endMs: nowMs + BREAK_SHATTER_DURATION_MS,
    });
  }

  private upsertTargeting(target: TargetingStateEvent): void {
    const center = tileCenterToScene(target.cx, target.cy, target.lx, target.ly);
    const existing = this.targetingByPlayer.get(target.playerId);
    if (existing) {
      existing.group.position.set(center.x, 0, center.z);
      this.updateDurabilityBar(existing, target.durabilityPct);
      return;
    }
    const tint = this.colorForPlayer(target.playerId);
    const group = new THREE.Group();
    group.position.set(center.x, 0, center.z);

    // Frame: outlined unit cube. Use `EdgesGeometry` over a box so the
    // corners stay sharp; line material avoids fill flicker at low alpha.
    const boxGeom = new THREE.BoxGeometry(
      TARGETING_FRAME_SIZE,
      TARGETING_FRAME_SIZE,
      TARGETING_FRAME_SIZE,
    );
    const edges = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();
    const frameMat = new THREE.LineBasicMaterial({
      color: tint,
      transparent: true,
      opacity: TARGETING_FRAME_OPACITY,
      depthWrite: false,
    });
    const frame = new THREE.LineSegments(edges, frameMat);
    frame.position.y = TARGETING_FRAME_LIFT;
    group.add(frame);

    const barBgGeom = new THREE.BoxGeometry(
      DURABILITY_BAR_MAX_WIDTH,
      DURABILITY_BAR_HEIGHT,
      DURABILITY_BAR_THICKNESS,
    );
    const barBgMat = new THREE.MeshBasicMaterial({
      color: DURABILITY_BAR_BG_COLOR,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const barBg = new THREE.Mesh(barBgGeom, barBgMat);
    barBg.position.y = DURABILITY_BAR_LIFT;
    group.add(barBg);

    // Fill: same geometry as bg, scaled along X by `pct/100`. Re-anchored
    // at construction so the scale grows from the left edge — a center-
    // anchored scale would shrink toward the middle, which reads wrong.
    const barFillGeom = new THREE.BoxGeometry(
      DURABILITY_BAR_MAX_WIDTH,
      DURABILITY_BAR_HEIGHT,
      DURABILITY_BAR_THICKNESS,
    );
    barFillGeom.translate(DURABILITY_BAR_MAX_WIDTH / 2, 0, 0);
    const barFillMat = new THREE.MeshBasicMaterial({
      color: DURABILITY_BAR_FILL_COLOR,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
    });
    const barFill = new THREE.Mesh(barFillGeom, barFillMat);
    barFill.position.set(-DURABILITY_BAR_MAX_WIDTH / 2, DURABILITY_BAR_LIFT, 0);
    // Slight forward bias so the fill never z-fights with the bg.
    barFill.position.z = -DURABILITY_BAR_THICKNESS * 0.05;
    group.add(barFill);

    this.group.add(group);
    const overlay: TargetingOverlay = {
      group,
      frame,
      frameMaterial: frameMat,
      barFill,
      barFillMaterial: barFillMat,
      barBg,
      barBgMaterial: barBgMat,
      lastPct: -1,
    };
    this.updateDurabilityBar(overlay, target.durabilityPct);
    this.targetingByPlayer.set(target.playerId, overlay);
  }

  private updateDurabilityBar(
    overlay: TargetingOverlay,
    rawPct: number,
  ): void {
    const pct = Math.max(0, Math.min(100, rawPct));
    if (pct === overlay.lastPct) return;
    overlay.lastPct = pct;
    const fill = pct / 100;
    overlay.barFill.scale.set(fill, 1, 1);
  }

  private disposePulse(pulse: PlacePulse): void {
    this.group.remove(pulse.mesh);
    pulse.mesh.geometry.dispose();
    pulse.material.dispose();
  }

  private disposeShatter(shatter: BreakShatter): void {
    this.group.remove(shatter.mesh);
    shatter.mesh.geometry.dispose();
    shatter.material.dispose();
  }

  private disposeTargeting(playerId: number): void {
    const overlay = this.targetingByPlayer.get(playerId);
    if (!overlay) return;
    this.targetingByPlayer.delete(playerId);
    this.group.remove(overlay.group);
    overlay.frame.geometry.dispose();
    overlay.frameMaterial.dispose();
    overlay.barFill.geometry.dispose();
    overlay.barFillMaterial.dispose();
    overlay.barBg.geometry.dispose();
    overlay.barBgMaterial.dispose();
  }
}
