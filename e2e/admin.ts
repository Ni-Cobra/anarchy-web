// Task 110: thin TS shims around the testing-mode admin endpoints exposed
// by the server (`anarchy-server/src/network/debug.rs`). Specs that need
// to plant authoritative state without simulating it through the wire
// (block placements, inventory items, player position) hit these helpers
// instead of reproducing the fetch calls inline.
//
// The endpoints are gated to testing mode server-side (404 outside), so
// these helpers will throw if the server was started without `--testing`.
// Playwright's webServer config in `playwright.config.ts` always passes
// `--testing` for the shared 8080 server.
//
// Numeric `ItemId` mirrors `proto::v1::ItemId` (see
// `anarchy-server/src/network/debug.rs::item_id_from_wire`).

const SERVER_URL = "http://localhost:8080";

export type AdminBlockKind =
  | "air"
  | "grass"
  | "wood"
  | "stone"
  | "gold"
  | "tree"
  | "sticks"
  | "torch"
  | "coal_ore"
  | "copper_ore"
  | "iron_ore"
  | "diamond_ore"
  | "tungsten_ore";

export type AdminBlockLayer = "top" | "ground";

/** Numeric `ItemId` wire values; mirror of the proto `ItemId` enum. */
export const AdminItemId = {
  Stick: 1,
  Wood: 2,
  Stone: 3,
  Gold: 4,
  WoodPickaxe: 5,
  StonePickaxe: 6,
  CopperPickaxe: 7,
  IronPickaxe: 8,
  TungstenPickaxe: 9,
  WoodAxe: 10,
  StoneAxe: 11,
  CopperAxe: 12,
  IronAxe: 13,
  TungstenAxe: 14,
  // Task 370 e2e: only the items the lantern recipe needs. Add other
  // items here as future specs require them.
  IronIngot: 31,
  Torch: 33,
  Lantern: 34,
  // Task 592 e2e: chest item, used by the multi-chest spec to seed two
  // placeable chests into the player's inventory.
  Chest: 36,
  // Task 050 e2e: log is used by the sword spec to seed wood-sword
  // ingredients into the player's inventory.
  Log: 35,
  // Task 050 e2e: wood-sword output, verified after the craft.
  WoodSword: 44,
  // Task 070a e2e: sword ladder used by the admin-driven attack specs.
  StoneSword: 45,
  CopperSword: 46,
  IronSword: 47,
  TungstenSword: 48,
  // Task 080 spider-string drop, used by the spider-kill spec to seed
  // inventory-full overflow scenarios.
  String: 49,
  // Task 180 spider venom-sack drop, raw input for the poison-dart recipe.
  VenomSack: 50,
  // Task 190 craftables — blowgun + poison dart.
  Blowgun: 51,
  PoisonDart: 52,
  // Task 220 craftables — cloth + colored flag. The flag-craft-place
  // spec seeds these into the inventory via the admin endpoint to drive
  // the cloth + flag recipes through the real UI.
  Cloth: 53,
  Flag: 54,
} as const;

export type AdminItemId = (typeof AdminItemId)[keyof typeof AdminItemId];

async function postOk(url: string): Promise<void> {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    throw new Error(`admin call failed: POST ${url} → ${r.status} ${r.statusText}`);
  }
}

/**
 * Drop `count` items of `item` (numeric `ItemId`) into the player's
 * inventory via `try_add` and flip the dirty bit so the next tick ships a
 * fresh `InventoryUpdate`. Counts > 255 are clamped server-side.
 */
export async function adminGiveItem(
  playerId: number,
  item: AdminItemId,
  count: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/give-item/${playerId}/${item}/${count}`);
}

/**
 * Set chunk `(cx, cy)` cell `(lx, ly)` on the named layer to `kind`. The
 * destination chunk is generated on demand if it isn't already loaded.
 */
export async function adminSetBlock(
  cx: number,
  cy: number,
  layer: AdminBlockLayer,
  lx: number,
  ly: number,
  kind: AdminBlockKind,
): Promise<void> {
  await postOk(
    `${SERVER_URL}/admin/set-block/${cx}/${cy}/${layer}/${lx}/${ly}/${kind}`,
  );
}

/**
 * Move player `id` to world coords `(x, y)` and zero their velocity. The
 * destination chunk is generated on demand if it isn't already loaded.
 */
export async function adminTeleport(
  playerId: number,
  x: number,
  y: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/teleport-player/${playerId}/${x}/${y}`);
}

/**
 * Spawn a fresh entity of `kind` at world tile `(tileX, tileY)` (task
 * 010-entities). Returns the allocated entity id parsed from the
 * response body. `409 Conflict` when the target tile isn't walkable;
 * the helper throws in that case so a failing test reads naturally.
 */
export async function adminSpawnEntity(
  kind: "spider",
  tileX: number,
  tileY: number,
): Promise<number> {
  const url = `${SERVER_URL}/admin/spawn-entity/${kind}/${tileX}/${tileY}`;
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    throw new Error(`admin call failed: POST ${url} → ${r.status} ${r.statusText}`);
  }
  const body = await r.text();
  const id = Number.parseInt(body, 10);
  if (!Number.isFinite(id)) {
    throw new Error(`admin spawn-entity returned non-numeric id: "${body}"`);
  }
  return id;
}

/**
 * Overwrite the world's authoritative `time_of_day_seconds` scalar (task
 * 330). The natural per-tick advance still applies; this just lets a
 * spec jump to a known phase (midnight to assert the night view radius,
 * dusk to watch the transition) instead of waiting ~10 minutes per
 * rotation.
 */
export async function adminSetTimeOfDay(seconds: number): Promise<void> {
  await postOk(`${SERVER_URL}/admin/set-time-of-day/${seconds}`);
}

/**
 * Outcome of a damage call. `alive` carries the post-hit HP; `killed`
 * means the hit landed the kill blow (and on the player path, the death
 * pipeline has already run — tombstone, inventory clear, respawn).
 */
export type DamageOutcome = { kind: "alive"; remainingHealth: number } | { kind: "killed" };

async function postDamage(url: string): Promise<DamageOutcome> {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    throw new Error(`admin call failed: POST ${url} → ${r.status} ${r.statusText}`);
  }
  const body = (await r.text()).trim();
  if (body === "killed") return { kind: "killed" };
  if (body.startsWith("alive:")) {
    const hp = Number.parseInt(body.slice("alive:".length), 10);
    return { kind: "alive", remainingHealth: hp };
  }
  throw new Error(`admin damage returned unparseable body: "${body}"`);
}

/**
 * Apply `amount` damage to player `playerId` (task 060). On a killing
 * blow the server runs the death pipeline (tombstone + respawn) before
 * returning, so the helper's resolution implies the world is already
 * post-respawn. When `killerId` is provided (task 210) the lethal hit
 * routes through `DeathCause::Pvp { killer }` and the victim's XP is
 * transferred to the killer; omitting it preserves the previous
 * `DeathCause::Admin` behaviour. Returns the server's damage outcome.
 */
export async function adminDamagePlayer(
  playerId: number,
  amount: number,
  killerId?: number,
): Promise<DamageOutcome> {
  let url = `${SERVER_URL}/admin/damage-player/${playerId}/${amount}`;
  if (killerId !== undefined) {
    url += `?killer=${killerId}`;
  }
  return postDamage(url);
}

/**
 * Saturating-add `amount` XP to the player's `xp` field (task 210). Used
 * by the e2e to plant a known XP on a victim before driving an admin
 * PvP kill so the transfer is observable on the killer's HUD.
 */
export async function adminGrantXp(
  playerId: number,
  amount: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/grant-xp/${playerId}/${amount}`);
}

/**
 * Apply `amount` damage to entity `entityId` (task 060). On kill the
 * server removes the entity from its chunk before returning. When
 * `killerId` is provided (task 080) the kind's drop table routes the
 * dropped stacks into that player's inventory via the same path an
 * in-engine sword strike would use; omitting it preserves the original
 * killer-less behaviour for specs that just want to remove the entity.
 */
export async function adminDamageEntity(
  entityId: number,
  amount: number,
  killerId?: number,
): Promise<DamageOutcome> {
  let url = `${SERVER_URL}/admin/damage-entity/${entityId}/${amount}`;
  if (killerId !== undefined) {
    url += `?killer=${killerId}`;
  }
  return postDamage(url);
}

/**
 * Synthesize an admin-driven `AttackIntent` from `attackerId` against
 * the named player or entity target (task 070a). Routes through the
 * same admission path a real `AttackIntent` from the client would take
 * — the server validates cooldown / range / self-target / existence
 * inside `World::apply_attack_intent`. A `400` from the server (e.g.
 * out of range, attacker still on cooldown) throws.
 */
export async function adminAttackPlayer(
  attackerId: number,
  targetId: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/attack-player/${attackerId}/${targetId}`);
}

export async function adminAttackEntity(
  attackerId: number,
  entityId: number,
): Promise<void> {
  await postOk(`${SERVER_URL}/admin/attack-entity/${attackerId}/${entityId}`);
}

/**
 * Equip the tool currently at `sourceSlot` into the player's equipment
 * slot named by `toolKind` (task 200b admin shim — used by the blowgun
 * e2e to set up the loadout without simulating a wire `EquipTool`).
 */
export type AdminToolKind =
  | "pickaxe"
  | "axe"
  | "utility"
  | "shovel"
  | "sword";

export async function adminEquipTool(
  playerId: number,
  toolKind: AdminToolKind,
  sourceSlot: number,
): Promise<void> {
  await postOk(
    `${SERVER_URL}/admin/equip-tool/${playerId}/${toolKind}/${sourceSlot}`,
  );
}

/**
 * Synthesise an admin-driven `FireBlowgunIntent` from `attackerId`
 * against the named player or entity target (task 200b). Routes
 * through the same admission path the wire intent would
 * (`World::spawn_poison_dart`). A `400` from the server (missing
 * blowgun, missing dart, out of range, on cooldown, self target,
 * unknown target) throws — the response body carries a JSON reason
 * the spec can pin in its error message.
 */
export async function adminFireBlowgun(
  attackerId: number,
  targetKind: "player" | "entity",
  targetId: number,
): Promise<void> {
  await postOk(
    `${SERVER_URL}/admin/fire-blowgun/${attackerId}/${targetKind}/${targetId}`,
  );
}

/**
 * Synthesise an admin-driven `CreateFactionIntent` from `playerId`
 * against the flag at `(cx, cy, lx, ly)` with `name` (task 240).
 * Routes through the same admission path the wire intent would
 * (`World::try_create_faction`). Returns the allocated faction id on
 * success; throws on rejection (status 4xx) carrying the server's
 * typed reason body — `no_flag_at_coord` (404), `flag_already_claimed`
 * (409), `not_placer` (403), `name_invalid` / `name_taken` (400).
 */
export async function adminCreateFaction(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  playerId: number,
  name: string,
): Promise<number> {
  const url = `${SERVER_URL}/admin/create-faction/${cx}/${cy}/${lx}/${ly}/${playerId}/${encodeURIComponent(name)}`;
  const r = await fetch(url, { method: "POST" });
  const body = (await r.text()).trim();
  if (!r.ok) {
    throw new Error(
      `admin create-faction failed: POST ${url} → ${r.status} ${r.statusText} ${body}`,
    );
  }
  const id = Number.parseInt(body, 10);
  if (!Number.isFinite(id)) {
    throw new Error(`admin create-faction returned non-numeric id: "${body}"`);
  }
  return id;
}

/**
 * Destroy faction `factionId` (task 240) — equivalent to breaking the
 * bound flag but without disturbing the world geometry. Idempotent:
 * a stale id silently succeeds.
 */
export async function adminDestroyFaction(factionId: number): Promise<void> {
  await postOk(`${SERVER_URL}/admin/destroy-faction/${factionId}`);
}

/**
 * Plant a `BlockType::Flag` directly on the top layer at the named
 * cell with `FlagBlockState { color_index, owner_id: Some(playerId),
 * faction_id: None }` (task 250). Bypasses the in-engine place path
 * so the e2e can stamp a flag with a known owner without crafting
 * via the UI.
 */
export async function adminPlaceFlag(
  playerId: number,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  color: number,
): Promise<void> {
  await postOk(
    `${SERVER_URL}/admin/place-flag/${playerId}/${cx}/${cy}/${lx}/${ly}/${color}`,
  );
}

/**
 * Apply a held `FlagInteractIntent` admin-driven (task 250). Routes
 * through `World::apply_flag_interact_intent` exactly like a wire
 * frame would. After this call returns the per-tick
 * `tick_flag_transfers` pass will start moving XP between the named
 * flag's faction and `playerId` at 10/s while `mode` admission holds.
 */
export async function adminFlagInteract(
  playerId: number,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  mode: "deposit" | "steal",
): Promise<void> {
  await postOk(
    `${SERVER_URL}/admin/flag-interact/${playerId}/${cx}/${cy}/${lx}/${ly}/${mode}`,
  );
}

/**
 * Release the player's current held flag-interact (task 250). Mirrors
 * a wire `FlagInteractIntent { active: false }` frame.
 */
export async function adminFlagInteractRelease(playerId: number): Promise<void> {
  await postOk(`${SERVER_URL}/admin/flag-interact-release/${playerId}`);
}
