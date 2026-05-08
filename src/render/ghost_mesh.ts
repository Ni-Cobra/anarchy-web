/**
 * Visual half of the ghost-block preview. `computeGhostState` in
 * `ghost.ts` is the pure-logic state computer; this module owns the
 * Three.js mesh that paints whatever state the renderer hands it.
 *
 * Split out of `renderer.ts` so the GPU-side resource lifecycle (mesh
 * creation, per-kind material swap, dispose) lives next to the constants
 * that govern the preview's geometry — and the renderer's per-frame
 * driver shrinks to a single `apply(state)` call.
 */

import * as THREE from "three";

import { type BlockType } from "../game/index.js";
import type { GhostState } from "./ghost.js";
import { tileCenterToScene } from "./terrain.js";
import type { BlockTextureSet } from "./texture_loader.js";

// Placement ghost: a semi-transparent unit-cube preview at the targeted
// top-layer cell. Sized to match a real placed top-layer block
// (`TOP_BOX_*` in `terrain.ts`) so what-you-see is what-you-get on click.
// The texture (sourced from the renderer's shared `BlockTextureSet`) is
// swapped per-kind so the preview shows the same surface as the placed
// block; a fallback flat color surfaces texture-less kinds loudly.
const GHOST_FALLBACK_COLOR = 0xff00ff;
const GHOST_OPACITY = 0.45;
const GHOST_BOX_SIZE = 1.0;
const GHOST_BOX_Y = 0.025 + GHOST_BOX_SIZE / 2;

/**
 * Owns the single ghost-preview cube mesh. Lazily instantiated on the
 * first non-`null` `apply`, hidden when state is `null`, and rebuilt in
 * place when the previewed block kind changes (the texture-backed
 * material swap is wholesale so per-kind GPU resources don't leak across
 * a mid-preview switch).
 */
export class GhostMesh {
  private mesh: THREE.Mesh | null = null;
  private kind: BlockType | null = null;
  private state: GhostState | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly blockTextures: BlockTextureSet,
  ) {}

  /**
   * Latest state passed to `apply`, or `null` when nothing is being
   * previewed. Read by Playwright via `__anarchy.getGhostState()` to
   * assert visibility end-to-end without inspecting Three.js internals.
   */
  getState(): GhostState | null {
    return this.state;
  }

  apply(state: GhostState | null): void {
    this.state = state;
    if (state === null) {
      if (this.mesh) this.mesh.visible = false;
      return;
    }
    if (!this.mesh) {
      const geom = new THREE.BoxGeometry(
        GHOST_BOX_SIZE,
        GHOST_BOX_SIZE,
        GHOST_BOX_SIZE,
      );
      this.mesh = new THREE.Mesh(geom, this.buildMaterial(state.kind));
      this.kind = state.kind;
      this.scene.add(this.mesh);
    } else if (this.kind !== state.kind) {
      // Swap the material wholesale on kind change so a texture-backed
      // and a flat-color preview can switch cleanly without leaking the
      // previous material's GPU resources.
      const oldMat = this.mesh.material as THREE.Material;
      this.mesh.material = this.buildMaterial(state.kind);
      oldMat.dispose();
      this.kind = state.kind;
    }
    const [cx, cy, lx, ly] = state.cell;
    const scenePos = tileCenterToScene(cx, cy, lx, ly);
    this.mesh.position.set(scenePos.x, GHOST_BOX_Y, scenePos.z);
    this.mesh.visible = true;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
  }

  private buildMaterial(kind: BlockType): THREE.MeshLambertMaterial {
    const tex = this.blockTextures.get(kind) ?? null;
    if (tex) {
      return new THREE.MeshLambertMaterial({
        map: tex,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false,
      });
    }
    return new THREE.MeshLambertMaterial({
      color: GHOST_FALLBACK_COLOR,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    });
  }
}
