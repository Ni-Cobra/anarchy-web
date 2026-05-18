/**
 * Mouse-driven held-break and place-block wiring (ADR 0006 + task 040).
 *
 * Owns:
 * - cursor-NDC mirror (every `mousemove` flows through
 *   `Renderer::setCursorNdc` so the per-frame ghost / hover billboard can
 *   pick at the cursor without DOM math).
 * - left-mouse-down → start held break, with a heartbeat resend every
 *   `BREAK_HEARTBEAT_TICKS` so a dropped intent frame can't strand the
 *   server with a stale view.
 * - mousemove while held → re-pick + retarget if the cell under the
 *   cursor has changed.
 * - left-mouse-up → release the held break.
 * - right-mouse-down → place the selected hotbar block at the cursor.
 * - `contextmenu` suppression so right-click doesn't tear the player out
 *   of the game.
 *
 * The reach gate (Euclidean distance to tile center ≤ `REACH_BLOCKS`)
 * mirrors the server's place / break validators so visibly-out-of-reach
 * actions never even ship.
 */

import {
  ATTACK_RANGE_TILES,
  BLOWGUN_COOLDOWN_MS,
  BLOWGUN_RANGE_TILES,
  BREAK_HEARTBEAT_TICKS,
  INPUT_TICK_INTERVAL_MS,
  REACH_BLOCKS,
} from "../config.js";
import { BlockType, CHUNK_SIZE, type Inventory, ItemId, type World } from "../game/index.js";
import { type Renderer } from "../render/index.js";
import { BLOCK_REGISTRY } from "../textures.js";
import { ToolTier, toolTierDisplayName } from "../tool_tier.js";
import { createMiningHint } from "./mining_hint.js";

const REACH_BLOCKS_SQ = REACH_BLOCKS * REACH_BLOCKS;

const ATTACK_RANGE_TILES_SQ = ATTACK_RANGE_TILES * ATTACK_RANGE_TILES;

const BLOWGUN_RANGE_TILES_SQ = BLOWGUN_RANGE_TILES * BLOWGUN_RANGE_TILES;

export interface BreakPlaceDeps {
  readonly world: World;
  readonly renderer: Renderer;
  readonly getLocalPlayerId: () => number | null;
  /**
   * Local-player inventory mirror — consulted to read the equipped pickaxe
   * tier for the task-150 mining gate. The gate suppresses
   * `BreakIntent` / `PlaceBlock` for ore cells the player can't mine and
   * surfaces a hint near the bottom of the screen. Server is authoritative;
   * this is purely the affordance.
   */
  readonly getInventory: () => Inventory;
  readonly sendBreakIntent: (
    target: { cx: number; cy: number; lx: number; ly: number } | null,
  ) => void;
  readonly sendPlaceBlock: (
    cx: number,
    cy: number,
    lx: number,
    ly: number,
  ) => void;
  /**
   * Task 240: notify the session that a place was just dispatched at
   * `(cx, cy, lx, ly)`. The session uses this to open the create-
   * faction dialog when the placed item was a Flag — break_place
   * doesn't know about factions, but it owns the place gate so the
   * dispatch order is correct.
   */
  readonly onPlaceDispatched?: (
    cx: number,
    cy: number,
    lx: number,
    ly: number,
  ) => void;
  /**
   * Task 420: right-click on a chest in range opens it. Optional — tests
   * that don't exercise the chest path leave it absent.
   */
  readonly sendOpenChest?: (
    cx: number,
    cy: number,
    lx: number,
    ly: number,
  ) => void;
  /**
   * Task 070b: ship an `AttackIntent` at `(kind, id)`. Optional — when
   * absent left-click falls through to the existing held-break path
   * unconditionally (used by tests that don't exercise attacks).
   */
  readonly sendAttackIntent?: (
    targetKind: "player" | "entity",
    targetId: number,
  ) => void;
  /**
   * Task 070b: resolve the world-space `(x, y)` of an attack target so
   * the client can gate on `ATTACK_RANGE_TILES` before shipping the
   * intent. Returns `null` when the target no longer exists (e.g. a
   * player walked out of view between mousedown and pick).
   */
  readonly getAttackTargetPosition?: (
    targetKind: "player" | "entity",
    targetId: number,
  ) => { x: number; y: number } | null;
  /**
   * Task 200c: ship a `FireBlowgunIntent` at `(kind, id)`. Optional —
   * tests that don't exercise the blowgun leave it absent and right-
   * click falls through to the existing place-block / open-chest path
   * unconditionally.
   */
  readonly sendFireBlowgunIntent?: (
    targetKind: "player" | "entity",
    targetId: number,
  ) => void;
  /**
   * Task 200c: notify the session that a `FireBlowgunIntent` was
   * dispatched at `nowMs` (post-gate). The session uses this to drive
   * the blowgun cooldown ring on the hotbar; break_place owns the gate.
   */
  readonly onBlowgunFireDispatched?: (nowMs: number) => void;
  /**
   * Task 200c: wall-clock-now read for the local cooldown gate. Optional
   * — tests can stub this to drive the gate's logic deterministically;
   * production passes `Date.now`.
   */
  readonly nowMs?: () => number;
}

/** Equipped pickaxe tier derived from the local-player inventory mirror. */
function equippedPickaxeTier(inventory: Inventory): ToolTier | null {
  const item = inventory.getEquipped("pickaxe");
  if (item === null) return null;
  switch (item) {
    case ItemId.WoodPickaxe:
      return ToolTier.Wood;
    case ItemId.StonePickaxe:
      return ToolTier.Stone;
    case ItemId.CopperPickaxe:
      return ToolTier.Copper;
    case ItemId.IronPickaxe:
      return ToolTier.Iron;
    case ItemId.TungstenPickaxe:
      return ToolTier.Tungsten;
    default:
      return null;
  }
}

/**
 * Install the mousemove / mousedown / mouseup / contextmenu listeners on
 * `target`. Returns a `detach` callback that removes every registered
 * listener and clears any in-flight heartbeat — pushing the result onto
 * the bootstrap teardown stack is what guarantees a clean reconnect cycle.
 */
export function attachBreakAndPlace(
  target: Window,
  deps: BreakPlaceDeps,
): () => void {
  // Held-break state (ADR 0006). While left-mouse is held we keep the
  // server's per-player `break_intent` synced with whatever tile the
  // cursor points at, plus a heartbeat resend every
  // `BREAK_HEARTBEAT_TICKS * INPUT_TICK_INTERVAL_MS` ms so a dropped
  // frame can't strand the held break with a stale view of the intent.
  let breakHeld = false;
  let lastBreakTarget:
    | { cx: number; cy: number; lx: number; ly: number }
    | null = null;
  let breakHeartbeat: ReturnType<typeof setInterval> | null = null;

  const miningHint = createMiningHint();

  // Task 200c: bandwidth-saver local cooldown gate. Suppresses repeat
  // `FireBlowgunIntent` sends inside the same ~1 s cooldown window the
  // server uses. The server is authoritative; this just avoids piling
  // no-op intents on the wire when the player mashes right-click.
  let lastBlowgunFireMs: number | null = null;
  const nowMs = deps.nowMs ?? (() => Date.now());

  /**
   * Pick the cell currently under the cursor. Returns the target plus a
   * `gated` flag: `true` means the cell is an ore whose `min_tool_tier`
   * exceeds the player's currently equipped pickaxe tier — the hint
   * surfaces the requirement so the player knows the swing is throttled,
   * but the held-break still ships (task 520: every block is breakable,
   * below-gate breakers tank the multiplier rate with no drop on
   * completion). `null` when no cell is in reach / loaded / non-Hidden.
   */
  function pickBreakTargetAt(
    clientX: number,
    clientY: number,
  ): {
    cx: number;
    cy: number;
    lx: number;
    ly: number;
    gated: boolean;
    gatedKind: BlockType | null;
    /** Block kind currently sitting under the cursor (top or ground — same
     *  pick the renderer surfaces). Used by the right-click router to
     *  decide between `PlaceBlock` and the task-420 `OpenChest` path. */
    targetBlock: BlockType;
  } | null {
    const localPlayerId = deps.getLocalPlayerId();
    if (localPlayerId === null) return null;
    const me = deps.world.getPlayer(localPlayerId);
    if (!me) return null;
    const ndc = {
      x: (clientX / target.innerWidth) * 2 - 1,
      y: -(clientY / target.innerHeight) * 2 + 1,
    };
    const pick = deps.renderer.pickAtCursor(ndc);
    if (!pick) return null;
    // Hidden cells (task 060): the server masks the underlying kind and
    // rejects break / place attempts on them. Reject client-side too so
    // the held-break visuals don't paint a fake target on a cell that
    // will never actually take damage.
    if (pick.block.kind === BlockType.Hidden) return null;
    // Both top and ground picks are valid break / place targets — the
    // server resolves which authoritative path runs (top-break vs
    // ground-break-via-replace, task 030) per held-item, so the client
    // doesn't need to gate on layer here.
    const [cx, cy] = pick.chunkCoord;
    const [lx, ly] = pick.localXY;
    const tileCenterX = cx * CHUNK_SIZE + lx + 0.5;
    const tileCenterY = cy * CHUNK_SIZE + ly + 0.5;
    const dx = tileCenterX - me.x;
    const dy = tileCenterY - me.y;
    if (dx * dx + dy * dy > REACH_BLOCKS_SQ) return null;
    const min = BLOCK_REGISTRY[pick.block.kind]?.minToolTier ?? null;
    let gated = false;
    if (min !== null) {
      const have = equippedPickaxeTier(deps.getInventory());
      if (have === null || have < min) gated = true;
    }
    return {
      cx,
      cy,
      lx,
      ly,
      gated,
      gatedKind: gated ? pick.block.kind : null,
      targetBlock: pick.block.kind,
    };
  }

  function targetsEqual(
    a: { cx: number; cy: number; lx: number; ly: number } | null,
    b: { cx: number; cy: number; lx: number; ly: number } | null,
  ): boolean {
    if (a === null) return b === null;
    if (b === null) return false;
    return a.cx === b.cx && a.cy === b.cy && a.lx === b.lx && a.ly === b.ly;
  }

  /** Strip the gate metadata from a pick result before storing it as the
   *  held-break target — the wire shape is just `{cx, cy, lx, ly}`. */
  function stripPick(
    pick: { cx: number; cy: number; lx: number; ly: number } | null,
  ): { cx: number; cy: number; lx: number; ly: number } | null {
    if (pick === null) return null;
    return { cx: pick.cx, cy: pick.cy, lx: pick.lx, ly: pick.ly };
  }

  function clientToNdc(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    return {
      x: (clientX / target.innerWidth) * 2 - 1,
      y: -(clientY / target.innerHeight) * 2 + 1,
    };
  }

  /** Surface the tier-gate hint for `kind`, or hide it when `kind` is null. */
  function applyHint(kind: BlockType | null): void {
    if (kind === null) {
      miningHint.hide();
      return;
    }
    const meta = BLOCK_REGISTRY[kind];
    const min = meta?.minToolTier ?? null;
    if (min === null) {
      miningHint.hide();
      return;
    }
    miningHint.show(
      `${meta.displayName} requires ${toolTierDisplayName(min)}+ Pickaxe`,
    );
  }

  function startBreakHeartbeat(): void {
    if (breakHeartbeat !== null) return;
    breakHeartbeat = setInterval(() => {
      if (!breakHeld) return;
      deps.sendBreakIntent(lastBreakTarget);
    }, BREAK_HEARTBEAT_TICKS * INPUT_TICK_INTERVAL_MS);
  }

  function stopBreakHeartbeat(): void {
    if (breakHeartbeat === null) return;
    clearInterval(breakHeartbeat);
    breakHeartbeat = null;
  }

  function endHeldBreak(): void {
    if (!breakHeld) return;
    breakHeld = false;
    stopBreakHeartbeat();
    if (lastBreakTarget !== null) {
      deps.sendBreakIntent(null);
      lastBreakTarget = null;
    }
  }

  const onMousemove = (ev: MouseEvent): void => {
    // Renderer drives the per-frame hover billboard from cursor NDC, so
    // every cursor sample needs to flow through `setCursorNdc` (see
    // `picker.ts`).
    deps.renderer.setCursorNdc({
      x: (ev.clientX / target.innerWidth) * 2 - 1,
      y: -(ev.clientY / target.innerHeight) * 2 + 1,
    });
    // Update the tier-gate hint independently of the held-break state so
    // hovering a too-hard ore explains the rejection even before the
    // player tries to mine it.
    const pick = pickBreakTargetAt(ev.clientX, ev.clientY);
    applyHint(pick?.gatedKind ?? null);
  };
  target.addEventListener("mousemove", onMousemove);

  const onMousedown = (ev: MouseEvent): void => {
    const localPlayerId = deps.getLocalPlayerId();
    if (localPlayerId === null) return;
    if (ev.button !== 0 && ev.button !== 2) return;
    if (ev.button === 0) {
      // Task 070b: a left-click that lands on a player or entity in
      // range is an attack — ship `AttackIntent` and fall through. The
      // pick is mesh-precise for players and tile-precise for entities;
      // out-of-range targets are silently dropped (server validates
      // anyway, but skipping the wire avoids piling up no-op intents).
      // No target under cursor → fall through to the held-break path.
      if (deps.sendAttackIntent && deps.getAttackTargetPosition) {
        const ndc = clientToNdc(ev.clientX, ev.clientY);
        const target = deps.renderer.pickAttackTargetAtCursor(ndc);
        if (target !== null) {
          const me = deps.world.getPlayer(localPlayerId);
          const pos = deps.getAttackTargetPosition(target.kind, target.id);
          if (me !== undefined && pos !== null) {
            const dx = pos.x - me.x;
            const dy = pos.y - me.y;
            if (dx * dx + dy * dy <= ATTACK_RANGE_TILES_SQ) {
              deps.sendAttackIntent(target.kind, target.id);
              return;
            }
          }
          // Target picked but out of range — drop the click silently
          // (server would reject anyway). The held-break path is
          // not started since the user's intent was to attack.
          return;
        }
      }
      // Left-click → start the held-break. The cursor's current tile
      // pick (if any, in reach) becomes the initial target — top or
      // ground; the server resolves which authoritative path runs. If
      // the cursor isn't over a valid target the held state still
      // starts — mousemove updates the target as the cursor scans
      // across the world; mouseup releases regardless.
      //
      // Task 520: even a `gated` pick (ore the player's tool can't
      // efficiently mine) ships the intent — the server applies the
      // throttled below-gate damage rate and suppresses the drop. The
      // hint surfaces the tool requirement; the held-break still makes
      // progress so "nothing should completely prevent the user from
      // destroying blocks even with empty hands" holds.
      breakHeld = true;
      const pick = pickBreakTargetAt(ev.clientX, ev.clientY);
      applyHint(pick?.gatedKind ?? null);
      lastBreakTarget = stripPick(pick);
      deps.sendBreakIntent(lastBreakTarget);
      startBreakHeartbeat();
      return;
    }
    // Task 200c: a right-click with a blowgun equipped is a fire-shoot,
    // not a place-block. The pick path resolves the cursor's target —
    // if it's a player or entity in range AND we have a dart, ship a
    // `FireBlowgunIntent`. Otherwise the click silently no-ops (mirrors
    // the attack-pick silent-drop posture). The local cooldown gate
    // suppresses repeat sends inside the same server cooldown window.
    if (
      deps.sendFireBlowgunIntent &&
      deps.getInventory().getEquipped("blowgun") === ItemId.Blowgun
    ) {
      // Suppress any place-block / open-chest fall-through while the
      // blowgun is equipped, regardless of whether the click resolves a
      // valid target. The brief calls this out explicitly: a right-click
      // on a block with the blowgun equipped must NOT place a block.
      const t = nowMs();
      if (lastBlowgunFireMs !== null && t - lastBlowgunFireMs < BLOWGUN_COOLDOWN_MS) {
        return;
      }
      const ndc = clientToNdc(ev.clientX, ev.clientY);
      const target = deps.renderer.pickAttackTargetAtCursor(ndc);
      if (target === null) return;
      if (deps.getInventory().countOf(ItemId.PoisonDart) < 1) return;
      const me = deps.world.getPlayer(localPlayerId);
      if (me === undefined) return;
      const pos = deps.getAttackTargetPosition
        ? deps.getAttackTargetPosition(target.kind, target.id)
        : null;
      if (pos === null) return;
      const dx = pos.x - me.x;
      const dy = pos.y - me.y;
      if (dx * dx + dy * dy > BLOWGUN_RANGE_TILES_SQ) return;
      deps.sendFireBlowgunIntent(target.kind, target.id);
      lastBlowgunFireMs = t;
      deps.onBlowgunFireDispatched?.(t);
      return;
    }
    // Right-click on a chest or tombstone in range → open it (task 420 /
    // task 010-tombstone). The pick path resolves the cursor's current
    // cell; if its top block is a storage block we ship `OpenChest`
    // instead of `PlaceBlock`. Server validates reach + cell-is-storage.
    const place = pickBreakTargetAt(ev.clientX, ev.clientY);
    if (place === null || place.gated) return;
    if (
      (place.targetBlock === BlockType.Chest || place.targetBlock === BlockType.Tombstone) &&
      deps.sendOpenChest
    ) {
      deps.sendOpenChest(place.cx, place.cy, place.lx, place.ly);
      return;
    }
    deps.sendPlaceBlock(place.cx, place.cy, place.lx, place.ly);
    deps.onPlaceDispatched?.(place.cx, place.cy, place.lx, place.ly);
  };
  target.addEventListener("mousedown", onMousedown);

  const onMouseup = (ev: MouseEvent): void => {
    if (ev.button !== 0) return;
    endHeldBreak();
  };
  target.addEventListener("mouseup", onMouseup);

  // While the break is held, every cursor sample re-picks the current
  // top-layer tile under the cursor. If the target tile has changed (or
  // we've moved off any valid target), ship a fresh intent so the server
  // updates `Player::break_intent` immediately rather than waiting for
  // the next heartbeat.
  const onMouseMoveBreakRetarget = (ev: MouseEvent): void => {
    if (!breakHeld) return;
    const pick = pickBreakTargetAt(ev.clientX, ev.clientY);
    const next = stripPick(pick);
    if (targetsEqual(next, lastBreakTarget)) return;
    lastBreakTarget = next;
    deps.sendBreakIntent(lastBreakTarget);
  };
  target.addEventListener("mousemove", onMouseMoveBreakRetarget);

  // Suppress the browser's right-click context menu so right-click can
  // drive place-block without tearing the player out of the game.
  const onContextMenu = (ev: MouseEvent): void => ev.preventDefault();
  target.addEventListener("contextmenu", onContextMenu);

  return () => {
    target.removeEventListener("mousemove", onMousemove);
    target.removeEventListener("mousedown", onMousedown);
    target.removeEventListener("mouseup", onMouseup);
    target.removeEventListener("mousemove", onMouseMoveBreakRetarget);
    target.removeEventListener("contextmenu", onContextMenu);
    stopBreakHeartbeat();
    miningHint.unmount();
  };
}
