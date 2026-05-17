/**
 * Strike-resolution slash render layer for the attack pipeline (task 130).
 *
 * The server emits `STRIKE_HIT` / `STRIKE_MISSED_OUT_OF_REACH` on every
 * resolved attack; the renderer routes each event into this layer plus
 * (for the local player's own strike) a punchy attacker-screen-shake
 * through the shared `ScreenShake` module from task 120.
 *
 * One quad per active slash: a flat textured plane laid in the ground
 * plane at the strike anchor, tinted by the attacker's palette colour,
 * fading and expanding linearly over `SLASH_LIFETIME_MS`. Slashes
 * from different attackers coexist; the layer keeps an array of active
 * meshes and retires each one when its lifetime elapses.
 *
 * Position anchors are caller-supplied:
 *   - `STRIKE_HIT`     → target's tile centre at resolution time.
 *   - `STRIKE_MISSED`  → attacker's post-dash landing tile.
 * Rotation is along the attacker → target vector so the arc visibly
 * crosses the strike line.
 */

import * as THREE from "three";

import { paletteColorHex } from "../game/index.js";

/** Slash lifetime in milliseconds. Short enough to read as a flash and
 *  to overlap with the 150 ms dash lerp without lingering after the
 *  attacker is back to a normal idle pose. */
export const SLASH_LIFETIME_MS = 250;
/** Quad edge length at spawn, in tile units. ~1.2 tiles so a strike
 *  on an adjacent tile visibly crosses both the attacker and the target. */
export const SLASH_BASE_SIZE_TILES = 1.2;
/** Final scale factor at retirement. The quad expands by this factor
 *  across `SLASH_LIFETIME_MS` so the slash feels like a punchy flash. */
export const SLASH_END_SCALE = 1.3;
/** Ground-plane elevation; matches the beam-body Y so the slash sits
 *  in the same horizontal layer the attack beam draws into. */
export const SLASH_BODY_Y = 0.5;
/** Asset path for the shared slash sprite. The texture is white-on-
 *  transparent so the material's tint colour multiplies cleanly to the
 *  attacker's palette colour. */
export const SLASH_TEXTURE_URL = "/textures/effects/slash.png";

/** Peak attacker-screen-shake magnitude in tiles. Smaller than the
 *  damage-received shake (which scales with HP loss) so the attacker's
 *  shake reads as a swing punch rather than a hit reaction. */
export const ATTACKER_SHAKE_TILES = 0.08;
/** Attacker-screen-shake duration in milliseconds. Short and sharp —
 *  the swing is a one-frame impulse, not a sustained rumble. */
export const ATTACKER_SHAKE_DURATION_MS = 120;

/** Inputs to a single `spawn(...)` call. */
export interface SlashSpawnInput {
  /** Attacker — only used for the test-handle lookup. */
  readonly attackerPlayerId: number;
  /** Palette index used to tint the sprite. */
  readonly attackerColorIndex: number;
  /** World-frame tile-centre to anchor the quad at. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** World-frame unit vector pointing along the strike line. The quad
   *  is rotated in the ground plane so its texture U-axis lies along
   *  this vector. A zero-length direction is treated as `(+1, 0)`. */
  readonly direction: { readonly x: number; readonly y: number };
  /** Wall-clock ms at which the slash spawned. Drives lifetime + decay. */
  readonly nowMs: number;
}

/**
 * The renderer spawns a slash on every strike outcome — hit OR miss —
 * so the visual is consistent regardless of resolution. Charge-started
 * events route into the attack-beam layer only; no slash on the charge.
 * Exported so the renderer's wiring can be pinned in unit tests without
 * instantiating a `WebGLRenderer`.
 */
export function shouldSpawnSlashFor(
  outcome: "charge-started" | "strike-hit" | "strike-missed",
): boolean {
  return outcome === "strike-hit" || outcome === "strike-missed";
}

/**
 * The attacker's own screen shakes briefly on every strike resolution —
 * a small punch fired by the swing, distinct from the larger damage-
 * received shake routed through the same `ScreenShake` module. Fires
 * only when the local viewer is the attacker; a remote player's strike
 * never moves the local camera.
 */
export function shouldTriggerAttackerShake(
  outcome: "charge-started" | "strike-hit" | "strike-missed",
  attackerPlayerId: number,
  localPlayerId: number | null,
): boolean {
  if (localPlayerId === null) return false;
  if (attackerPlayerId !== localPlayerId) return false;
  return outcome === "strike-hit" || outcome === "strike-missed";
}

/** Linear `1 → 0` alpha taper across the slash lifetime, clamped. */
export function slashAlphaAt(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (elapsedMs >= SLASH_LIFETIME_MS) return 0;
  return 1 - elapsedMs / SLASH_LIFETIME_MS;
}

/** Linear `1.0 → SLASH_END_SCALE` scale factor across the slash lifetime. */
export function slashScaleAt(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (elapsedMs >= SLASH_LIFETIME_MS) return SLASH_END_SCALE;
  const t = elapsedMs / SLASH_LIFETIME_MS;
  return 1 + (SLASH_END_SCALE - 1) * t;
}

interface SlashState {
  readonly id: number;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly attackerPlayerId: number;
  readonly spawnMs: number;
}

/**
 * Per-frame slash render layer. Owns a `THREE.Group` carrying one
 * quad mesh per live slash. Caller workflow:
 *
 *   `spawn(...)`  on `STRIKE_HIT` / `STRIKE_MISSED_OUT_OF_REACH`.
 *   `tick(nowMs)` once per frame to update alpha / scale and retire
 *                 expired slashes.
 *   `clearAll()`  on local-player reassign.
 *   `dispose()`   on renderer teardown.
 */
export class SlashLayer {
  readonly group: THREE.Group;
  private readonly slashes: SlashState[] = [];
  private readonly unitGeometry: THREE.PlaneGeometry;
  private readonly texture: THREE.Texture | null;
  private nextId = 0;

  constructor(texture: THREE.Texture | null = null) {
    this.group = new THREE.Group();
    this.group.name = "attack-slashes";
    // Unit quad sized to the base footprint; lying flat in the ground
    // plane (rotated by the per-mesh transform below). Shared across
    // every slash to keep GPU allocations stable.
    this.unitGeometry = new THREE.PlaneGeometry(
      SLASH_BASE_SIZE_TILES,
      SLASH_BASE_SIZE_TILES,
    );
    this.texture = texture;
  }

  spawn(input: SlashSpawnInput): void {
    const material = new THREE.MeshBasicMaterial({
      color: paletteColorHex(input.attackerColorIndex),
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
      map: this.texture,
    });
    const mesh = new THREE.Mesh(this.unitGeometry, material);
    orientSlashMesh(mesh, input.anchor, input.direction);
    mesh.scale.set(1, 1, 1);
    this.group.add(mesh);
    const id = this.nextId++;
    this.slashes.push({
      id,
      mesh,
      material,
      attackerPlayerId: input.attackerPlayerId,
      spawnMs: input.nowMs,
    });
  }

  tick(nowMs: number): void {
    // Walk back-to-front so removal-during-iteration stays correct.
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      const s = this.slashes[i];
      const elapsed = nowMs - s.spawnMs;
      if (elapsed >= SLASH_LIFETIME_MS) {
        this.retireAt(i);
        continue;
      }
      const alpha = slashAlphaAt(elapsed);
      const scale = slashScaleAt(elapsed);
      s.material.opacity = alpha;
      s.mesh.scale.set(scale, scale, scale);
    }
  }

  size(): number {
    return this.slashes.length;
  }

  clearAll(): void {
    while (this.slashes.length > 0) this.retireAt(this.slashes.length - 1);
  }

  dispose(): void {
    this.clearAll();
    this.unitGeometry.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }

  /** Test handle: colour of the n-th live slash, or `null` if absent. */
  slashColorHexAt(index: number): number | null {
    const s = this.slashes[index];
    return s ? s.material.color.getHex() : null;
  }

  /** Test handle: scene-space `(x, y, z)` of the n-th live slash. */
  slashPositionAt(index: number): { x: number; y: number; z: number } | null {
    const s = this.slashes[index];
    return s
      ? { x: s.mesh.position.x, y: s.mesh.position.y, z: s.mesh.position.z }
      : null;
  }

  /** Test handle: current `material.opacity` of the n-th live slash. */
  slashAlphaAt(index: number): number | null {
    const s = this.slashes[index];
    return s ? s.material.opacity : null;
  }

  /** Test handle: current uniform scale factor of the n-th live slash. */
  slashScaleAt(index: number): number | null {
    const s = this.slashes[index];
    return s ? s.mesh.scale.x : null;
  }

  /** Test handle: attacker player id of the n-th live slash. */
  slashAttackerAt(index: number): number | null {
    const s = this.slashes[index];
    return s ? s.attackerPlayerId : null;
  }

  private retireAt(index: number): void {
    const s = this.slashes[index];
    if (!s) return;
    this.slashes.splice(index, 1);
    this.group.remove(s.mesh);
    s.material.dispose();
    // `unitGeometry` is shared — disposed by `dispose()` once at teardown.
  }
}

/**
 * Lay a quad flat in the ground plane at `anchor`, rotated so its
 * texture U-axis lies along `direction` (world frame, where +x = east
 * and +y = north → scene `(+x, -z)`). Exported for unit tests that
 * pin the transform without a full layer round-trip.
 */
export function orientSlashMesh(
  mesh: THREE.Mesh,
  anchor: { readonly x: number; readonly y: number },
  direction: { readonly x: number; readonly y: number },
): void {
  mesh.position.set(anchor.x, SLASH_BODY_Y, -anchor.y);
  // Lay the default-XY plane flat in the ground plane (normal +Y).
  mesh.rotation.set(-Math.PI / 2, 0, 0);
  // Then rotate around scene Y so the quad's local +X (texture U-axis)
  // points along the strike vector. World `(x, y)` maps to scene
  // `(x, -z)`, so a world-frame direction `(dx, dy)` becomes scene-frame
  // `(dx, -dy)` for the rotation calculation. After the `RotateX(-π/2)`
  // above, the quad's local +X is still scene +X, so `angle =
  // atan2(-dy, dx)` rotates the quad into the right ground-plane heading.
  let dx = direction.x;
  let dy = direction.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len <= 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const angle = Math.atan2(-dy, dx);
  mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), angle);
}
