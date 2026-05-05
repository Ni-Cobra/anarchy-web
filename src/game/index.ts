/**
 * Authoritative-state mirror, network-free.
 *
 * Nothing in this module — or any submodule — may know about WebSockets,
 * protobuf, or any wire format. Translation from server messages into
 * mutations on `World` and `SnapshotBuffer` lives in `net/wire.ts`.
 */
export type { Player, PlayerId } from "./player.js";
export { Direction8, DEFAULT_FACING } from "./player.js";
export { World } from "./world.js";
export { SnapshotBuffer } from "./snapshot_buffer.js";
export type { Block, Chunk, ChunkCoord, Layer } from "./terrain.js";
export {
  BlockType,
  CHUNK_SIZE,
  LAYER_AREA,
  LAYER_SIZE,
  Terrain,
  emptyChunk,
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
} from "./inventory.js";
export type { ItemStack, Slot } from "./inventory.js";
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
