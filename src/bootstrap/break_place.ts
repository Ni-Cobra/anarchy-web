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

import { BREAK_HEARTBEAT_TICKS, INPUT_TICK_INTERVAL_MS, REACH_BLOCKS } from "../config.js";
import { BlockType, CHUNK_SIZE, type World } from "../game/index.js";
import { type Renderer } from "../render/index.js";

const REACH_BLOCKS_SQ = REACH_BLOCKS * REACH_BLOCKS;

export interface BreakPlaceDeps {
  readonly world: World;
  readonly renderer: Renderer;
  readonly getLocalPlayerId: () => number | null;
  readonly sendBreakIntent: (
    target: { cx: number; cy: number; lx: number; ly: number } | null,
  ) => void;
  readonly sendPlaceBlock: (
    cx: number,
    cy: number,
    lx: number,
    ly: number,
  ) => void;
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

  function pickBreakTargetAt(
    clientX: number,
    clientY: number,
  ): { cx: number; cy: number; lx: number; ly: number } | null {
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
    return { cx, cy, lx, ly };
  }

  function targetsEqual(
    a: { cx: number; cy: number; lx: number; ly: number } | null,
    b: { cx: number; cy: number; lx: number; ly: number } | null,
  ): boolean {
    if (a === null) return b === null;
    if (b === null) return false;
    return a.cx === b.cx && a.cy === b.cy && a.lx === b.lx && a.ly === b.ly;
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
  };
  target.addEventListener("mousemove", onMousemove);

  const onMousedown = (ev: MouseEvent): void => {
    const localPlayerId = deps.getLocalPlayerId();
    if (localPlayerId === null) return;
    if (ev.button !== 0 && ev.button !== 2) return;
    if (ev.button === 0) {
      // Left-click → start the held-break. The cursor's current tile
      // pick (if any, in reach) becomes the initial target — top or
      // ground; the server resolves which authoritative path runs. If
      // the cursor isn't over a valid target the held state still
      // starts — mousemove updates the target as the cursor scans
      // across the world; mouseup releases regardless.
      breakHeld = true;
      lastBreakTarget = pickBreakTargetAt(ev.clientX, ev.clientY);
      deps.sendBreakIntent(lastBreakTarget);
      startBreakHeartbeat();
      return;
    }
    // Right-click → place the selected hotbar slot's block on the tile
    // under the cursor. Server validates reach + top-Air + slot kind.
    const place = pickBreakTargetAt(ev.clientX, ev.clientY);
    if (place === null) return;
    deps.sendPlaceBlock(place.cx, place.cy, place.lx, place.ly);
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
    const next = pickBreakTargetAt(ev.clientX, ev.clientY);
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
  };
}
