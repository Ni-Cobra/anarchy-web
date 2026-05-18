/**
 * Faction-name shape validation (task 240).
 *
 * Mirror of the server's `validate_faction_name` in
 * `anarchy-server/src/game/faction/mod.rs`: trim leading/trailing ASCII
 * whitespace, then verify length and charset (`[A-Za-z0-9 _-]+`).
 * Returns the trimmed name on success, or a typed error variant.
 *
 * Lives in `game/` so the create-faction dialog UI can lean on it
 * without dragging in the wire layer; the server re-validates on
 * admission so even a misbehaving client cannot create a malformed
 * faction.
 */

export const MIN_FACTION_NAME_LEN = 1;
export const MAX_FACTION_NAME_LEN = 24;

export type FactionNameError = "empty" | "too_long" | "bad_char";

export function validateFactionName(
  raw: string,
): { ok: true; name: string } | { ok: false; reason: FactionNameError } {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_FACTION_NAME_LEN) {
    return { ok: false, reason: "empty" };
  }
  if (trimmed.length > MAX_FACTION_NAME_LEN) {
    return { ok: false, reason: "too_long" };
  }
  for (const ch of trimmed) {
    if (!isFactionNameChar(ch)) {
      return { ok: false, reason: "bad_char" };
    }
  }
  return { ok: true, name: trimmed };
}

function isFactionNameChar(ch: string): boolean {
  return /^[A-Za-z0-9 _-]$/.test(ch);
}
