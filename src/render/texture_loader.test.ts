// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { BlockType } from "../game/index.js";
import { BLOCK_REGISTRY } from "../textures.js";
import { disposeBlockTextures, loadBlockTextures } from "./texture_loader.js";

/**
 * Stub `TextureLoader` that produces a bare `THREE.Texture` per `load(url)`
 * call without actually fetching pixels. We're testing that the loader
 * configures every texture for crisp pixel-art display, not that the
 * underlying THREE machinery downloads bytes.
 */
class StubLoader extends THREE.TextureLoader {
  readonly loaded: string[] = [];
  override load(url: string): THREE.Texture {
    this.loaded.push(url);
    return new THREE.Texture();
  }
}

describe("loadBlockTextures", () => {
  it("loads one texture per visible block kind, configured for pixel-art rendering", () => {
    const loader = new StubLoader();
    const set = loadBlockTextures(loader);

    // Every kind with a non-null textureUrl in the registry should have
    // produced a `load` call.
    const expectedUrls = Object.values(BLOCK_REGISTRY)
      .map((m) => m.textureUrl)
      .filter((u): u is string => u !== null);
    expect(loader.loaded.sort()).toEqual([...expectedUrls].sort());

    for (const kind of [
      BlockType.Grass,
      BlockType.Wood,
      BlockType.Stone,
      BlockType.Gold,
      BlockType.Tree,
      BlockType.Sticks,
    ]) {
      const tex = set.get(kind);
      expect(tex).toBeInstanceOf(THREE.Texture);
      expect(tex!.minFilter).toBe(THREE.NearestFilter);
      expect(tex!.magFilter).toBe(THREE.NearestFilter);
      expect(tex!.generateMipmaps).toBe(false);
      expect(tex!.colorSpace).toBe(THREE.SRGBColorSpace);
    }
    expect(set.has(BlockType.Air)).toBe(false);
  });
});

describe("disposeBlockTextures", () => {
  it("disposes every loaded texture exactly once", () => {
    const loader = new StubLoader();
    const set = loadBlockTextures(loader);
    const calls = new Map<THREE.Texture, number>();
    for (const tex of set.values()) {
      const orig = tex.dispose.bind(tex);
      tex.dispose = () => {
        calls.set(tex, (calls.get(tex) ?? 0) + 1);
        orig();
      };
    }
    disposeBlockTextures(set);
    for (const count of calls.values()) {
      expect(count).toBe(1);
    }
    expect(calls.size).toBe(set.size);
  });
});
