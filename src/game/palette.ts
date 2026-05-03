/**
 * Lobby palette + per-session identity validation. Mirrors
 * `anarchy-server/src/game/lobby.rs` — the project charter calls this out
 * as the one allowed redundancy because the lobby UI must offer only
 * options the server will accept.
 *
 * Wire shape: `ClientHello.color_index` is an index into `PALETTE`. Order
 * is wire-stable — never reorder, only append.
 */

export interface PaletteColor {
  /** sRGB byte (0-255). */
  readonly r: number;
  /** sRGB byte (0-255). */
  readonly g: number;
  /** sRGB byte (0-255). */
  readonly b: number;
  /** Short name for the lobby UI (`aria-label` on the swatch button). */
  readonly name: string;
}

/**
 * Lobby palette. Eight entries picked for contrast on the grass-green
 * ground texture. Indices match the server-side `PALETTE` slice.
 */
export const PALETTE: readonly PaletteColor[] = [
  { r: 0xff, g: 0x30, b: 0x30, name: "Red" },
  { r: 0xff, g: 0x90, b: 0x30, name: "Orange" },
  { r: 0xf5, g: 0xd0, b: 0x42, name: "Yellow" },
  { r: 0x30, g: 0xd0, b: 0xff, name: "Cyan" },
  { r: 0x30, g: 0x70, b: 0xff, name: "Blue" },
  { r: 0xa0, g: 0x40, b: 0xff, name: "Purple" },
  { r: 0xff, g: 0x60, b: 0xa0, name: "Pink" },
  { r: 0xf0, g: 0xf0, b: 0xf0, name: "White" },
];

export const MIN_USERNAME_LEN = 1;
export const MAX_USERNAME_LEN = 16;

const USERNAME_PATTERN = /^[A-Za-z0-9_\- ]+$/;

/**
 * Returns the trimmed/normalized username on success, or `null` if it
 * fails the same rules the server enforces in `validate_username`. The
 * server is authoritative; this is for the lobby UI's submit gate so a
 * legitimate client never gets disconnected for a malformed Hello.
 */
export function validateUsername(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_USERNAME_LEN || trimmed.length > MAX_USERNAME_LEN) {
    return null;
  }
  if (!USERNAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function isValidColorIndex(idx: number): boolean {
  return Number.isInteger(idx) && idx >= 0 && idx < PALETTE.length;
}

/** Hex string `#rrggbb` for the renderer's `THREE.Color` constructor. */
export function paletteColorHex(idx: number): number {
  const c = PALETTE[idx] ?? PALETTE[0];
  return (c.r << 16) | (c.g << 8) | c.b;
}

/** CSS `rgb(...)` string for the lobby swatch background. */
export function paletteColorCss(idx: number): string {
  const c = PALETTE[idx] ?? PALETTE[0];
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}
