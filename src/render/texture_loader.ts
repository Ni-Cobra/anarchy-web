/**
 * THREE-side block-texture loader. Reads URL paths from `src/textures.ts`
 * and turns them into `THREE.Texture` instances configured for crisp
 * pixel-art display: `NearestFilter` on min + mag, no mipmaps, sRGB color
 * space (so the PNG bytes sample as authored regardless of renderer
 * gamma).
 *
 * One `BlockTextureSet` is built at renderer construction time and shared
 * across every chunk-mesh build, the ghost preview, and any future
 * texture-consuming visual. Sharing matters for memory: a single 64×64
 * texture is cheap, but a fresh upload per chunk-build (chunks rebuild on
 * every block edit) would burn GPU bandwidth needlessly.
 */

import * as THREE from "three";

import { BlockType } from "../game/index.js";
import { BLOCK_REGISTRY } from "../textures.js";

/** Loaded texture per `BlockType`. Kinds whose `BLOCK_REGISTRY` entry has a
 *  null `textureUrl` (notably `Air` and `Hidden`) are absent — callers
 *  must guard. */
export type BlockTextureSet = ReadonlyMap<BlockType, THREE.Texture>;

/**
 * Load every block texture once. Returns a frozen map keyed by
 * `BlockType`. The optional `loader` parameter exists so tests can inject
 * a stub; production callers omit it.
 */
export function loadBlockTextures(
  loader: THREE.TextureLoader = new THREE.TextureLoader(),
): BlockTextureSet {
  const out = new Map<BlockType, THREE.Texture>();
  for (const meta of Object.values(BLOCK_REGISTRY)) {
    if (meta.textureUrl === null) continue;
    const tex = loader.load(meta.textureUrl);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    out.set(meta.kind, tex);
  }
  return out;
}

/**
 * Dispose every texture in the set. Called from the renderer's `dispose`
 * to release GPU resources at teardown. Safe to call once per set — each
 * `THREE.Texture.dispose()` is idempotent past the first invocation in
 * practice (it just clears already-cleared GPU handles).
 */
export function disposeBlockTextures(set: BlockTextureSet): void {
  for (const tex of set.values()) tex.dispose();
}
