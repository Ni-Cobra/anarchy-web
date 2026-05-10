/**
 * Per-player visual: body sphere with painted eyes, optional username
 * billboard. The factory is the construction half — building a fresh
 * `THREE.Mesh` for an admitted player. The hover helper is the
 * per-frame half — toggling each player's billboard against the cursor's
 * hovered id.
 *
 * Split out of `renderer.ts` so the player visual concerns (geometry,
 * texture math, billboard layout) live alongside each other, and the
 * renderer module can stay focused on the render loop and scene wiring.
 */

import * as THREE from "three";

import { PLAYER_RADIUS } from "../config.js";
import { ItemId, paletteColorHex, type PlayerId } from "../game/index.js";
import type { PlayerMeshFactory, RenderableEntity } from "./sync.js";

// The player's body sphere mirrors the authoritative collision radius
// (`PLAYER_RADIUS` in `config.ts`, `crate::game::player::PLAYER_RADIUS`
// on the server) so visuals and authority agree on what "touching" means.
const BODY_RADIUS = PLAYER_RADIUS;
const BODY_SEGMENTS = 16;
// Painted face. Eyes are drawn into the body's CanvasTexture instead of
// being separate child meshes — drops two child meshes per player and
// lets future expressions (blinks, emotes) become 2D texture edits with
// no geometry churn. The body sphere's local +X is the player's "front"
// (see `facingToYaw`), which on the default Three.js sphere UV maps to
// the texture's horizontal midpoint, so eyes painted symmetrically
// around `s = 0.5` always sit on the facing-forward hemisphere.
const BODY_TEXTURE_W = 256;
const BODY_TEXTURE_H = 128;
// Eye texture coords derived from the previous child-eye offsets:
// position (0.266, 0.126, ±0.14) projected to the unit sphere then
// converted via the inverse of the default Three.js sphere UV mapping.
// `EYE_T` is the texture's vertical coord (1 - latitude/π, with the
// flipY default making canvas-Y = (1 - t) * H).
const EYE_S_RIGHT = 0.423;
const EYE_S_LEFT = 0.577;
const EYE_T = 0.618;
const EYE_WHITE_RADIUS_PX = 12;
const EYE_WHITE_COLOR = "#ffffff";

// Username billboard. `BILLBOARD_HEIGHT_OFFSET` is in scene units (Three.js
// Y-up); the sprite parents to the body mesh so it follows the player. The
// sprite uses a `CanvasTexture` of the rendered name so we can choose
// font + outline + size without depending on a Three.js-side font loader.
// The sprite size is sized in world units so it stays readable at default
// camera zoom; sprites by definition always face the camera.
//
// The offset puts the *bottom* of the sprite just above the sphere top:
// sphere top sits at `BODY_RADIUS` above the body center, the sprite is
// anchored at its center with height `BILLBOARD_WORLD_HEIGHT`, so its
// bottom is at `BILLBOARD_HEIGHT_OFFSET - BILLBOARD_WORLD_HEIGHT/2`. We
// keep ~0.025 of clearance so the label feels attached without floating.
const BILLBOARD_WORLD_HEIGHT = 0.45;
const BILLBOARD_HEIGHT_OFFSET = BODY_RADIUS + BILLBOARD_WORLD_HEIGHT / 2 + 0.025;
const BILLBOARD_FONT_PX = 56;
const BILLBOARD_PAD_PX = 12;
const BILLBOARD_TEXT_COLOR = "#ffffff";
const BILLBOARD_OUTLINE_COLOR = "#000000";
const BILLBOARD_OUTLINE_WIDTH = 6;
// Property key on `mesh.userData` where the per-player billboard sprite is
// stashed at create time. The frame loop reads this via
// `applyHoverBillboards` to toggle visibility against the hovered-player
// id from the cursor picker; gating it through a single key lets the
// sprite stay parented to the body (so it follows movement automatically)
// without exposing a parallel sprite map.
const BILLBOARD_USERDATA_KEY = "usernameBillboard";

// Lantern-glow emissive tint applied to a player's body material whenever
// the server reports `ItemId.Lantern` in their Utility slot (task 450).
// Pure white per the task spec — the world-space lantern light is what
// adds warmth; this is just the player model picking up "I am lit". Off
// state goes back to a black emissive so the body reverts to pure diffuse.
const LANTERN_GLOW_COLOR_HEX = 0xffffff;
const LANTERN_GLOW_INTENSITY = 0.55;

export const defaultPlayerMeshFactory: PlayerMeshFactory = {
  create(entity: RenderableEntity, _isLocal: boolean) {
    const bodyGeom = new THREE.SphereGeometry(
      BODY_RADIUS,
      BODY_SEGMENTS,
      BODY_SEGMENTS,
    );
    // The body color is the player's lobby palette pick; both local and
    // remote players are tinted the same way (the local player is
    // distinguishable by camera follow + their own billboard).
    const bodyMat = buildBodyMaterial(paletteColorHex(entity.colorIndex));
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    // Day-cycle shadows (task 310). Players cast onto terrain and receive
    // from neighbouring blocks, so a player walking into a tree's shade
    // visually darkens.
    body.castShadow = true;
    body.receiveShadow = true;

    if (entity.username.length > 0) {
      const billboard = buildUsernameBillboard(entity.username);
      // Hidden by default — the renderer's per-frame hover pass flips
      // `visible` for whichever body is under the cursor.
      billboard.visible = false;
      body.userData[BILLBOARD_USERDATA_KEY] = billboard;
      body.add(billboard);
    }

    return body;
  },
};

/**
 * Build the body material with eyes painted into a `CanvasTexture` mapped
 * onto the sphere. Falls back to a flat-color material when no 2D canvas
 * context is available (headless test envs); the body still renders, just
 * without eyes — matching the renderer's prior fault-tolerant style for
 * the username billboard.
 */
function buildBodyMaterial(bodyColorHex: number): THREE.MeshLambertMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = BODY_TEXTURE_W;
  canvas.height = BODY_TEXTURE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.MeshLambertMaterial({ color: bodyColorHex });

  const r = (bodyColorHex >> 16) & 0xff;
  const g = (bodyColorHex >> 8) & 0xff;
  const b = bodyColorHex & 0xff;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, BODY_TEXTURE_W, BODY_TEXTURE_H);

  // CanvasTexture defaults to flipY = true, so canvas y = (1 - t) * H
  // for a target texture coord t.
  const eyeY = (1 - EYE_T) * BODY_TEXTURE_H;
  for (const s of [EYE_S_LEFT, EYE_S_RIGHT]) {
    const cx = s * BODY_TEXTURE_W;
    ctx.fillStyle = EYE_WHITE_COLOR;
    ctx.beginPath();
    ctx.arc(cx, eyeY, EYE_WHITE_RADIUS_PX, 0, 2 * Math.PI);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return new THREE.MeshLambertMaterial({ map: texture });
}

/**
 * Render the username into an offscreen 2D canvas and wrap it as a
 * `THREE.Sprite` so it always faces the camera. The sprite parents to the
 * body so it follows the player; world height is fixed in scene units so
 * the label stays readable at default zoom regardless of canvas pixel
 * density. The body mesh is yawed each frame to track the player's facing,
 * so the sprite is parented to a wrapper that we counter-rotate inverse to
 * the body — without that, the billboard would orbit the body whenever the
 * player turned. Sprites already cancel rotation against the camera, but
 * the parent transform applies before that, hence the wrapper.
 */
function buildUsernameBillboard(username: string): THREE.Object3D {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Headless / no-2d-canvas fallback — return an empty group rather
    // than crashing. The renderer-level tests stub `THREE` and never see
    // this path, but defensive rendering keeps a missing 2d ctx visible
    // as "no name above head" rather than a thrown exception.
    return new THREE.Group();
  }
  ctx.font = `${BILLBOARD_FONT_PX}px system-ui, sans-serif`;
  const metrics = ctx.measureText(username);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = BILLBOARD_FONT_PX;
  canvas.width = textWidth + BILLBOARD_PAD_PX * 2;
  canvas.height = textHeight + BILLBOARD_PAD_PX * 2;
  // Re-set font after the canvas resize (mutating width/height resets ctx).
  ctx.font = `${BILLBOARD_FONT_PX}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = BILLBOARD_OUTLINE_WIDTH;
  ctx.strokeStyle = BILLBOARD_OUTLINE_COLOR;
  ctx.fillStyle = BILLBOARD_TEXT_COLOR;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.strokeText(username, cx, cy);
  ctx.fillText(username, cx, cy);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  // The body counter-rotates with facing (see `syncPlayerMeshes`); wrap the
  // sprite in a group so we can compensate for the body's local Y rotation
  // each frame in `Renderer.frame` if needed. Today the sprite parent is
  // the body itself, but Sprite always faces the camera in world space, so
  // the body's yaw is irrelevant for the sprite's orientation — the offset
  // position is what we care about, and that's a Z-up offset in body-local
  // space that we set once.
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(BILLBOARD_WORLD_HEIGHT * aspect, BILLBOARD_WORLD_HEIGHT, 1);
  sprite.position.set(0, BILLBOARD_HEIGHT_OFFSET, 0);
  // Render on top so the label isn't hidden by the body sphere when the
  // player is partially behind a top-layer block.
  sprite.renderOrder = 999;
  return sprite;
}

/**
 * Toggle each player's username billboard against `hoveredId`: visible
 * only on the hovered body, hidden on every other. `null` hides all.
 * Players whose factory didn't attach a billboard (empty username at
 * create time) are silently skipped.
 */
export function applyHoverBillboards(
  meshes: ReadonlyMap<PlayerId, THREE.Mesh>,
  hoveredId: PlayerId | null,
): void {
  for (const [id, mesh] of meshes) {
    const billboard = mesh.userData[BILLBOARD_USERDATA_KEY] as
      | THREE.Object3D
      | undefined;
    if (!billboard) continue;
    billboard.visible = id === hoveredId;
  }
}

/** Subset of `RenderableEntity` `applyLanternGlow` consumes — just the id
 *  and the Utility slot. Looser than the full entity so test callers can
 *  build a minimal struct without standing up a renderable. */
export interface LanternGlowEntity {
  readonly id: PlayerId;
  readonly equippedUtility: ItemId | null;
}

/**
 * Toggle the lantern emissive glow on each player body (task 450).
 * Walks `entities` to collect the set of players whose Utility slot
 * reports `ItemId.Lantern`, then sets the body material's `emissive`
 * + `emissiveIntensity` to the configured tint for those bodies and
 * clears it for everyone else. Materials whose shader doesn't expose
 * `emissive` (e.g. the `MeshBasicMaterial` used by test factories) are
 * silently skipped — the emissive read is in-place, so a missing field
 * just means the visual effect doesn't apply in that test env.
 *
 * Per-frame to handle equip/unequip mid-session and to bring just-spawned
 * remote players into the right state on their first render.
 */
export function applyLanternGlow(
  meshes: ReadonlyMap<PlayerId, THREE.Mesh>,
  entities: Iterable<LanternGlowEntity>,
): void {
  const wearers = new Set<PlayerId>();
  for (const e of entities) {
    if (e.equippedUtility === ItemId.Lantern) wearers.add(e.id);
  }
  for (const [id, mesh] of meshes) {
    const mat = mesh.material as THREE.Material & {
      emissive?: THREE.Color;
      emissiveIntensity?: number;
    };
    if (!mat || !(mat as { emissive?: unknown }).emissive) continue;
    if (wearers.has(id)) {
      mat.emissive!.setHex(LANTERN_GLOW_COLOR_HEX);
      mat.emissiveIntensity = LANTERN_GLOW_INTENSITY;
    } else {
      mat.emissive!.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
  }
}
