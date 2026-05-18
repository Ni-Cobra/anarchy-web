/**
 * Authoritative-state mirror, network-free.
 *
 * Nothing in this module — or any submodule — may know about WebSockets,
 * protobuf, or any wire format. Translation from server messages into
 * mutations on `World` and `SnapshotBuffer` lives in `net/wire.ts`.
 */
export type { Entity, EntityId } from "./entity.js";
export { EntityKind } from "./entity.js";
export type { ActiveEffect, OpenChestRef, Player, PlayerId } from "./player.js";
export { Direction8, DEFAULT_FACING, EffectKind, MAX_PLAYER_HEALTH } from "./player.js";
export { maxHealthForKind } from "./entity.js";
export { World } from "./world.js";
export { SnapshotBuffer } from "./snapshot_buffer.js";
export {
  LOCAL_CHARGE_FAILSAFE_MS,
  LocalAttackChargeTracker,
} from "./local_attack_charge_tracker.js";
export type { Block, Chunk, ChunkCoord, FlagBlockState, Layer } from "./terrain.js";
export {
  BlockType,
  CHUNK_SIZE,
  LAYER_AREA,
  LAYER_SIZE,
  Terrain,
  emptyChunk,
  flagCellKey,
  getBlock,
  setBlock,
} from "./terrain.js";
export { canPlaceTopBlock } from "./place_validation.js";
export {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  MAIN_SLOTS,
  isAxe,
  isPickaxe,
  isUtility,
  toolKindOf,
} from "./inventory.js";
export type {
  CraftableRecipe,
  ItemStack,
  ItemStackExtra,
  RecipeAvailability,
  Slot,
  ToolKind,
} from "./inventory.js";
export {
  PROJECTILE_LERP_MS,
  ProjectileStore,
  projectileVelocity,
  sampleProjectilePosition,
} from "./projectiles.js";
export type {
  ProjectileKind,
  ProjectileSnapshot,
  ProjectileState,
  ProjectileTarget,
  ProjectileTargetKind,
} from "./projectiles.js";
export { ChestState } from "./chest_state.js";
export type { ChestLocation } from "./chest_state.js";
export { RosterStore } from "./roster.js";
export type { Roster, RosterEntry, RosterListener } from "./roster.js";
export {
  LeaderboardStore,
  currentLeader,
  sortedByXpDesc,
} from "./leaderboard.js";
export type {
  FactionEntry,
  FactionId,
  LeaderboardListener,
} from "./leaderboard.js";
export {
  MAX_FACTION_NAME_LEN,
  MIN_FACTION_NAME_LEN,
  validateFactionName,
} from "./faction_name.js";
export type { FactionNameError } from "./faction_name.js";
export { chestKeyOf, chestLocationFromKey } from "./chest_key.js";
export type { ChestKey } from "./chest_key.js";
export {
  MAX_USERNAME_LEN,
  MIN_USERNAME_LEN,
  PALETTE,
  isValidColorIndex,
  paletteColorCss,
  paletteColorHex,
  validateUsername,
} from "./palette.js";
export type { PaletteColor } from "./palette.js";
