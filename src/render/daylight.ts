/**
 * Day-cycle sun + ambient sampler (task 310). Pure math — no `three` import,
 * no DOM — so the renderer can plug it in and the unit tests can pin the
 * angle / colour curves without a WebGL context.
 *
 * The server is the only authority for time. It ships a monotonically
 * growing `time_of_day_seconds` scalar on every `TickUpdate`; the client
 * folds it modulo `DAY_LENGTH_SECONDS` to derive `phase ∈ [0, 1)` and reads
 * back a directional sun position + colour and an ambient floor.
 *
 *   phase = 0     → sunrise (sun on the +x horizon)
 *   phase = 0.25  → noon    (sun at zenith above the world)
 *   phase = 0.5   → sunset  (sun on the -x horizon)
 *   phase = 0.75  → midnight (sun directly below; light intensity floors)
 *
 * The sun travels a great circle in the xz=0 plane of three.js (so the
 * renderer can plant `sun.position = sunDir * R` and let the default
 * `target = (0, 0, 0)` aim the cone back at the world).
 */

import { DAY_LENGTH_SECONDS } from "../config.js";

export interface DaylightSample {
  /** `phase ∈ [0, 1)`. `0` is sunrise, `0.25` noon, `0.5` sunset, `0.75` midnight. */
  readonly phase: number;
  /** Unit vector from world origin toward the sun. Three.js scene axes. */
  readonly sunDir: { readonly x: number; readonly y: number; readonly z: number };
  /** Sun-light intensity in `[NIGHT_FLOOR_INTENSITY, SUN_PEAK_INTENSITY]`. */
  readonly sunIntensity: number;
  /** Ambient light intensity in `[NIGHT_AMBIENT, DAY_AMBIENT]`. */
  readonly ambientIntensity: number;
  /** Hex colour for the directional sun (warm at horizons, cool at noon). */
  readonly sunColor: number;
  /** Hex colour for the ambient term (matches `sunColor`'s mood). */
  readonly ambientColor: number;
  /** Hex colour for the scene background (sky). */
  readonly skyColor: number;
  /**
   * Night factor in `[0, 1]`. `0` whenever the sun is on or above the
   * horizon (sunrise / day / sunset); ramps to `1` at midnight. Consumers
   * like the torch / lantern light pool (task 350 / 370) scale their
   * intensity by this so artificial light only meaningfully contributes
   * once natural light has fallen.
   */
  readonly nightFactor: number;
}

// Intensity envelope. The sun never goes fully dark (otherwise night is a
// solid black smear); ambient never tops the day value either, so noon
// reads as the bright extreme rather than a washed-out midnight.
export const SUN_PEAK_INTENSITY = 1.1;
// Bumped from 0.05 (task 120): the previous floor still painted shaded
// faces near-black at midnight. 0.12 lifts the sun-light contribution
// enough that geometry stays readable while preserving the clear "the
// sun is gone" mood — peak/floor ratio drops from 22× to ~9×, still a
// strong contrast against the SUN_PEAK_INTENSITY noon extreme.
export const NIGHT_FLOOR_INTENSITY = 0.12;
export const DAY_AMBIENT = 0.55;
// Bumped from 0.26 (task 120) — the prior tuning still felt "can barely
// see" at midnight. 0.38 keeps a clear day-vs-night contrast against
// the 0.55 day ambient (~1.45× day vs ~3.7× before, still mood-shifting)
// while making the world legible without a torch.
export const NIGHT_AMBIENT = 0.38;

// Sun-arc orientation (task 440). The arc is originally a great circle in
// the xz=0 plane — noon sat at the +y zenith, so shaded faces read flat.
// We rotate the arc twice so the noon zenith lands on a half-diagonal in
// the xz plane (small off-vertical tilt + 45° azimuth in the xz plane).
// First rotate around +x by `NOON_TILT_RAD` (pushes noon zenith toward +z),
// then around +y by `NOON_AZIMUTH_RAD` (rotates the arc so noon ends up
// equally toward +x and +z). Sunrise / sunset stay on the horizon because
// the around-+x rotation fixes points on the +x axis (where sin(theta)=0).
const NOON_TILT_RAD = (22 * Math.PI) / 180;
const NOON_AZIMUTH_RAD = Math.PI / 4;
const NOON_TILT_COS = Math.cos(NOON_TILT_RAD);
const NOON_TILT_SIN = Math.sin(NOON_TILT_RAD);
const NOON_AZ_COS = Math.cos(NOON_AZIMUTH_RAD);
const NOON_AZ_SIN = Math.sin(NOON_AZIMUTH_RAD);

// Palette stops. The renderer interpolates between these along the
// `daylight` curve below; the goal is "noon reads cooler / whiter than
// the warm sunrise + sunset wedges, and night settles into a deep blue".
const COLOR_NOON_SUN = 0xfff3d6;
const COLOR_HORIZON_SUN = 0xffb060;
const COLOR_NIGHT_SUN = 0x4060c0;

const COLOR_NOON_AMBIENT = 0xeef2ff;
const COLOR_HORIZON_AMBIENT = 0xffd4a8;
const COLOR_NIGHT_AMBIENT = 0x182238;

const COLOR_NOON_SKY = 0x8ec8ff;
const COLOR_HORIZON_SKY = 0xff9c5a;
const COLOR_NIGHT_SKY = 0x0a1428;

/**
 * Convert raw seconds into a normalised `phase ∈ [0, 1)`. Negative inputs
 * (a corrupt or hand-edited save) wrap into the same range so a corrupt
 * value never crashes the renderer; `NaN` collapses to `0` (sunrise).
 */
export function dayPhaseFromSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return ((seconds / DAY_LENGTH_SECONDS) % 1 + 1) % 1;
}

/**
 * Sample the daylight envelope at `seconds`. Pure of `three` — the
 * renderer plugs the result into a `DirectionalLight` + `AmbientLight`
 * each frame.
 */
export function sampleDaylight(seconds: number): DaylightSample {
  const phase = dayPhaseFromSeconds(seconds);
  // theta = 0 at sunrise, π/2 at noon (arc-zenith), π at sunset, 3π/2 at
  // midnight. `elevation = sin(theta)` is the sun's height along its arc;
  // we keep it as the envelope variable for intensity + colour (so noon
  // is always the bright extreme regardless of arc tilt) and derive the
  // tilted sunDir below from the same theta. With NOON_TILT_RAD = 0 the
  // two are identical (sunDir.y == elevation).
  const theta = phase * 2 * Math.PI;
  const elevation = Math.sin(theta);
  // Un-tilted basis: arc lives in the xz=0 plane with x = cos(theta),
  // y = sin(theta) = elevation, z = 0. Rotate around +x by the tilt
  // (mixes a slice of y into z), then around +y by the azimuth (mixes
  // x and z so the noon zenith ends up half-diagonal rather than +z-only).
  const baseX = Math.cos(theta);
  const tiltedY = elevation * NOON_TILT_COS;
  const tiltedZ = elevation * NOON_TILT_SIN;
  const sunDir = {
    x: baseX * NOON_AZ_COS + tiltedZ * NOON_AZ_SIN,
    y: tiltedY,
    z: -baseX * NOON_AZ_SIN + tiltedZ * NOON_AZ_COS,
  };

  // Two-stage colour blend.
  //   1. dayColor lerps between horizon (sun on horizon, |elevation| ≈ 0)
  //      and noon (sun overhead, elevation == 1) when the sun is up.
  //   2. final colour lerps between night (when sun is below horizon by
  //      a wide margin) and dayColor (when sun is up).
  // `dayWeight` is `max(0, elevation)`: 1 at zenith, 0 at horizon. So
  // dayColor at horizon = horizonColor; dayColor at noon = noonColor.
  // `nightWeight` is `max(0, -elevation)`: 0 anywhere above the horizon,
  // 1 at midnight. So at exactly horizon the final colour is dayColor
  // (which is horizonColor) — sunrise / sunset read warm, not midnight-
  // blue.
  const dayWeight = Math.max(0, elevation);
  const nightWeight = Math.max(0, -elevation);
  const sunDayColor = blendColors(COLOR_HORIZON_SUN, COLOR_NOON_SUN, dayWeight);
  const ambDayColor = blendColors(COLOR_HORIZON_AMBIENT, COLOR_NOON_AMBIENT, dayWeight);
  const skyDayColor = blendColors(COLOR_HORIZON_SKY, COLOR_NOON_SKY, dayWeight);
  const sunColor = blendColors(sunDayColor, COLOR_NIGHT_SUN, nightWeight);
  const ambientColor = blendColors(ambDayColor, COLOR_NIGHT_AMBIENT, nightWeight);
  const skyColor = blendColors(skyDayColor, COLOR_NIGHT_SKY, nightWeight);

  // Intensity envelope: a smooth lobe peaking at noon, floor-clamped at
  // night so the world never dips into a solid black smear.
  const sunIntensity =
    NIGHT_FLOOR_INTENSITY + (SUN_PEAK_INTENSITY - NIGHT_FLOOR_INTENSITY) * dayWeight;
  const ambientIntensity =
    NIGHT_AMBIENT + (DAY_AMBIENT - NIGHT_AMBIENT) * dayWeight;

  return {
    phase,
    sunDir,
    sunIntensity,
    ambientIntensity,
    sunColor,
    ambientColor,
    skyColor,
    nightFactor: nightWeight,
  };
}

/**
 * Lerp two `0xRRGGBB` colours channel-wise. `t` is clamped to `[0, 1]` so a
 * caller passing a slightly-out-of-range envelope value can't produce
 * negative channels.
 */
function blendColors(a: number, b: number, t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * tt);
  const g = Math.round(ag + (bg - ag) * tt);
  const bl = Math.round(ab + (bb - ab) * tt);
  return (r << 16) | (g << 8) | bl;
}
