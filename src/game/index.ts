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
export { LocalPredictor } from "./predictor.js";
export type { Block, Chunk, Layer } from "./terrain.js";
export {
  AIR_BLOCK,
  BlockType,
  CHUNK_SIZE,
  LAYER_AREA,
  LAYER_SIZE,
  Terrain,
  chunkCoordForWorldPos,
  chunkKey,
  emptyChunk,
  emptyLayer,
  filledLayer,
  getBlock,
  layerIdx,
  parseChunkKey,
  setBlock,
} from "./terrain.js";
