/**
 * What lives in the Three.js scene. The `SceneGraph` builds the static
 * scene tree at construction time — scene, camera, WebGL renderer, player
 * and terrain groups, lights, effects and beam layers, the ghost overlay,
 * and the chunk-border debug grid — and exposes typed accessors so the
 * orchestrating `Renderer` can drive a per-frame update without owning
 * any of the GPU-resident objects itself.
 *
 * Three.js identity is load-bearing: the picker raycasts against player
 * mesh references owned upstream, and the ghost overlay parents to
 * `terrainGroup`. The `SceneGraph` therefore *owns* these references and
 * never recreates them — accessors return the same instance across the
 * lifetime of the graph.
 */

import * as THREE from "three";

import { CHUNK_SIZE, type PlayerId, type Terrain } from "../game/index.js";
import {
  BeamLayer,
  BreakParticles,
  defaultBreakParticleColor,
  EffectsLayer,
} from "./effects/index.js";
import { GhostMesh } from "./ghost_mesh.js";
import { LanternLights } from "./lantern_lights.js";
import { MushroomLights } from "./mushroom_lights.js";
import { TorchLights } from "./torch_lights.js";
import {
  buildChunkMesh,
  buildTerrainMesh,
  disposeTerrainMesh,
  mushroomPositionsInChunk,
  torchPositionsInChunk,
} from "./terrain.js";
import {
  type BlockTextureSet,
  disposeBlockTextures,
  loadBlockTextures,
} from "./texture_loader.js";

const AXIS_HALF_LENGTH = 10000;
const AXIS_Y_OFFSET = 0.01;
const AXIS_X_COLOR = 0xff5050;
const AXIS_Y_COLOR = 0x60a0ff;

// Day-cycle directional sun (task 310). The sun sits on a sphere of this
// radius around the camera focus so its world-space angle reads correctly
// from any viewpoint while keeping the shadow camera frustum bounded. The
// shadow camera is a square orthographic frustum sized to the camera's
// reach — bigger than the visible window so blocks just past the edge can
// still cast into it.
const SUN_DISTANCE = 60;
const SHADOW_HALF_EXTENT = 50;
const SHADOW_MAP_SIZE = 1024;

// Chunk-border debug overlay (only visible in zoom-out mode). The grid
// covers a fixed bounded region in world coords — large enough that the
// local player can't walk off the edge in a normal session — and uses a
// single `LineSegments` mesh so the whole grid is one draw call regardless
// of the line count. Y offset sits a hair above the world axis so the
// grid doesn't z-fight with the axis lines on platforms that don't write
// stable depth for line primitives.
const CHUNK_GRID_HALF_CHUNKS = 64;
const CHUNK_GRID_HALF = CHUNK_GRID_HALF_CHUNKS * CHUNK_SIZE;
const CHUNK_GRID_Y_OFFSET = AXIS_Y_OFFSET + 0.005;
const CHUNK_GRID_COLOR = 0xa0a0a0;
const CHUNK_GRID_OPACITY = 0.35;

/**
 * Initial viewport state passed in from the caller. Keeps the renderer
 * free of `window` queries so DOM access stays in `main.ts`.
 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

/**
 * Lookup the renderer hands in so the effects layer can tint pulses /
 * shatters by the actor's lobby colour without `SceneGraph` having to
 * know about `World`.
 */
export type ColorIndexLookup = (id: PlayerId) => number | null;

/**
 * Owns the Three.js scene + camera + render target plus every persistent
 * sub-graph the renderer paints into. Accessors are read-only references
 * — never reassigned across the lifetime of the graph — so the picker
 * and ghost overlay can hold onto them without invalidation.
 */
export class SceneGraph {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly webgl: THREE.WebGLRenderer;
  readonly playerGroup: THREE.Group;
  readonly blockTextures: BlockTextureSet;
  readonly ghost: GhostMesh;
  readonly effects: EffectsLayer;
  readonly beams: BeamLayer;
  readonly breakParticles: BreakParticles;
  readonly torchLights: TorchLights;
  readonly mushroomLights: MushroomLights;
  readonly lanternLights: LanternLights;
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.AmbientLight;

  private readonly ground: THREE.Mesh;
  private readonly chunkBorderGrid: THREE.LineSegments;
  private terrainGroupRef: THREE.Group | null = null;

  constructor(
    container: HTMLElement,
    viewport: Viewport,
    initialTerrain: Terrain | null,
    getPlayerColorIndex: ColorIndexLookup,
  ) {
    this.blockTextures = loadBlockTextures();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202028);

    this.camera = new THREE.PerspectiveCamera(
      60,
      viewport.width / viewport.height,
      0.1,
      1000,
    );
    this.camera.up.set(0, 0, -1);

    this.webgl = new THREE.WebGLRenderer({ antialias: true });
    this.webgl.setPixelRatio(viewport.pixelRatio);
    this.webgl.setSize(viewport.width, viewport.height);
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.webgl.domElement);

    // Day-cycle lights (task 310). Plain values set here are placeholders;
    // the per-frame `updateDaylight` resamples colour + intensity + sun
    // position every frame from the synced `time_of_day_seconds`.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const shadowCam = this.sun.shadow.camera as THREE.OrthographicCamera;
    shadowCam.left = -SHADOW_HALF_EXTENT;
    shadowCam.right = SHADOW_HALF_EXTENT;
    shadowCam.top = SHADOW_HALF_EXTENT;
    shadowCam.bottom = -SHADOW_HALF_EXTENT;
    shadowCam.near = 0.5;
    shadowCam.far = SUN_DISTANCE * 2 + SHADOW_HALF_EXTENT;
    shadowCam.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshLambertMaterial({ color: 0x2a4d2a }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.scene.add(
      buildAxisLine(
        new THREE.Vector3(-AXIS_HALF_LENGTH, AXIS_Y_OFFSET, 0),
        new THREE.Vector3(AXIS_HALF_LENGTH, AXIS_Y_OFFSET, 0),
        AXIS_X_COLOR,
      ),
    );
    this.scene.add(
      buildAxisLine(
        new THREE.Vector3(0, AXIS_Y_OFFSET, -AXIS_HALF_LENGTH),
        new THREE.Vector3(0, AXIS_Y_OFFSET, AXIS_HALF_LENGTH),
        AXIS_Y_COLOR,
      ),
    );

    this.playerGroup = new THREE.Group();
    this.scene.add(this.playerGroup);

    this.torchLights = new TorchLights();
    this.scene.add(this.torchLights.scene());

    this.mushroomLights = new MushroomLights();
    this.scene.add(this.mushroomLights.scene());

    this.lanternLights = new LanternLights();
    this.scene.add(this.lanternLights.scene());

    if (initialTerrain !== null) {
      this.terrainGroupRef = buildTerrainMesh(initialTerrain, this.blockTextures);
      this.scene.add(this.terrainGroupRef);
      // Seed the torch + mushroom light layers from any chunks that came
      // in with the initial terrain — `replaceChunk` is the steady-state
      // path, but construction with a non-null terrain bypasses it.
      for (const [coord, chunk] of initialTerrain.iter()) {
        this.torchLights.setChunkTorches(
          coord[0],
          coord[1],
          torchPositionsInChunk(coord[0], coord[1], chunk),
        );
        this.mushroomLights.setChunkMushrooms(
          coord[0],
          coord[1],
          mushroomPositionsInChunk(coord[0], coord[1], chunk),
        );
      }
    }

    this.ghost = new GhostMesh(this.scene, this.blockTextures);

    this.effects = new EffectsLayer(getPlayerColorIndex);
    this.scene.add(this.effects.scene());

    this.beams = new BeamLayer();
    this.scene.add(this.beams.scene());

    this.breakParticles = new BreakParticles(defaultBreakParticleColor);
    this.scene.add(this.breakParticles.scene());

    this.chunkBorderGrid = buildChunkBorderGrid();
    this.chunkBorderGrid.visible = false;
    this.scene.add(this.chunkBorderGrid);
  }

  /** Lazily allocated on the first chunk apply, then stable. */
  get terrainGroup(): THREE.Group | null {
    return this.terrainGroupRef;
  }

  /**
   * Replace one chunk's sub-group inside the terrain mesh (or create the
   * terrain group on first call). Leaves neighbouring chunks untouched.
   * Mirrors the chunk-centric tick model: the server ships full-state
   * chunks and the renderer rebuilds them in place.
   */
  replaceChunk(cx: number, cy: number, terrain: Terrain): void {
    const chunk = terrain.get(cx, cy);
    if (!chunk) return;
    const root = this.terrainGroupOrCreate();
    this.disposeChunkSubgroup(cx, cy, root);
    root.add(buildChunkMesh(cx, cy, chunk, this.blockTextures, terrain));
    this.torchLights.setChunkTorches(
      cx,
      cy,
      torchPositionsInChunk(cx, cy, chunk),
    );
    this.mushroomLights.setChunkMushrooms(
      cx,
      cy,
      mushroomPositionsInChunk(cx, cy, chunk),
    );
  }

  /** Drop a chunk's sub-group from the terrain mesh. */
  removeChunk(cx: number, cy: number): void {
    if (!this.terrainGroupRef) return;
    this.disposeChunkSubgroup(cx, cy, this.terrainGroupRef);
    this.torchLights.removeChunk(cx, cy);
    this.mushroomLights.removeChunk(cx, cy);
  }

  /** Debug overlay shown only in zoom-out mode (see `Renderer.setZoomedOut`). */
  setChunkBorderVisible(on: boolean): void {
    this.chunkBorderGrid.visible = on;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.webgl.setSize(width, height);
  }

  /**
   * Tear the entire scene tree down. Order matters here: layers that hold
   * their own scene-attached groups (effects, beams, particles, lights)
   * dispose first so their nodes are detached cleanly, then the terrain
   * group, the chunk-border grid, the block-texture set, and finally the
   * WebGL renderer and its DOM canvas.
   */
  dispose(): void {
    if (this.terrainGroupRef) {
      disposeTerrainMesh(this.terrainGroupRef, this.scene);
      this.terrainGroupRef = null;
    }
    this.ghost.dispose();
    this.effects.dispose();
    this.beams.dispose();
    this.breakParticles.dispose();
    this.torchLights.dispose();
    this.scene.remove(this.torchLights.scene());
    this.mushroomLights.dispose();
    this.scene.remove(this.mushroomLights.scene());
    this.lanternLights.dispose();
    this.scene.remove(this.lanternLights.scene());
    this.scene.remove(this.chunkBorderGrid);
    this.chunkBorderGrid.geometry.dispose();
    (this.chunkBorderGrid.material as THREE.Material).dispose();
    disposeBlockTextures(this.blockTextures);
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }

  private terrainGroupOrCreate(): THREE.Group {
    if (this.terrainGroupRef) return this.terrainGroupRef;
    const g = new THREE.Group();
    g.name = "terrain";
    this.scene.add(g);
    this.terrainGroupRef = g;
    return g;
  }

  private disposeChunkSubgroup(
    cx: number,
    cy: number,
    root: THREE.Group,
  ): void {
    const name = `chunk:${cx},${cy}`;
    const existing = root.children.find((c) => c.name === name);
    if (!existing) return;
    disposeTerrainMesh(existing, root);
  }
}

function buildAxisLine(
  from: THREE.Vector3,
  to: THREE.Vector3,
  color: number,
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({ color });
  return new THREE.Line(geometry, material);
}

/**
 * Build a single `LineSegments` mesh holding every chunk-border line in a
 * fixed bounded region around the world origin. World coords map to scene
 * with `(+x_world, +y_world) → (+x_scene, -z_scene)` (mirroring
 * `tileCenterToScene`), so a vertical world-space line at `world_x = k`
 * becomes a constant-`scene_x` segment varying in scene Z.
 */
function buildChunkBorderGrid(): THREE.LineSegments {
  const positions: number[] = [];
  for (let i = -CHUNK_GRID_HALF_CHUNKS; i <= CHUNK_GRID_HALF_CHUNKS; i++) {
    const k = i * CHUNK_SIZE;
    positions.push(k, CHUNK_GRID_Y_OFFSET, -CHUNK_GRID_HALF);
    positions.push(k, CHUNK_GRID_Y_OFFSET, CHUNK_GRID_HALF);
    positions.push(-CHUNK_GRID_HALF, CHUNK_GRID_Y_OFFSET, -k);
    positions.push(CHUNK_GRID_HALF, CHUNK_GRID_Y_OFFSET, -k);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: CHUNK_GRID_COLOR,
    transparent: true,
    opacity: CHUNK_GRID_OPACITY,
  });
  return new THREE.LineSegments(geometry, material);
}
