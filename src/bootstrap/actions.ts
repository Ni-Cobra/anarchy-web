/**
 * Wire-frame senders for in-game player actions. Each helper builds the
 * outbound `ClientMessage` shape and ships it via `conn.send`. Helpers
 * that carry a `clientSeq` field share a single per-session monotonic
 * counter encapsulated here — bootstrap no longer juggles the variable
 * across half a dozen call sites.
 *
 * Per ADR 0003 §7 prediction is retired; the client no longer reconciles
 * against `clientSeq`, but the server still expects a strictly-increasing
 * counter and may surface it again later, so every sequenced send is
 * still gated by `++actionSeq`.
 *
 * `placeBlock` deliberately ships without a `clientSeq` — task 040 made
 * place authoritative-only and the wire frame doesn't carry one.
 */

import type { ChestLocation, ToolKind } from "../game/index.js";
import type { Connection } from "../net/index.js";

export interface ActionSenders {
  sendMoveIntent(dx: number, dy: number): void;
  sendBreakIntent(
    target: { cx: number; cy: number; lx: number; ly: number } | null,
  ): void;
  sendPlaceBlock(cx: number, cy: number, lx: number, ly: number): void;
  sendSelectSlot(slot: number): void;
  /**
   * Ship a `MoveSlot` drag-drop action up to the server. The optional
   * `srcChest` / `dstChest` arguments name which chest a slot index
   * lives in (task 590 multi-open); pass `null` (or omit) when the slot
   * lives in the player's own grid.
   */
  sendMoveSlot(
    src: number,
    dst: number,
    srcChest?: ChestLocation | null,
    dstChest?: ChestLocation | null,
  ): void;
  /**
   * Ship a `TransferItems(src, dst, count)` action up to the server
   * (BACKLOG 410 right-click split). Strict partial transfer — the server
   * refuses mismatched-kind destinations rather than swapping. The
   * right-click hold UI ships repeated `count = 1` frames as the timer
   * ramps up; drag-and-drop full-stack moves still go through `sendMoveSlot`.
   * The cross-grid arguments mirror `sendMoveSlot` (task 590).
   */
  sendTransferItems(
    src: number,
    dst: number,
    count: number,
    srcChest?: ChestLocation | null,
    dstChest?: ChestLocation | null,
  ): void;
  sendCraft(recipeId: string): void;
  sendEquipTool(sourceSlot: number, kind: ToolKind): void;
  sendUnequipTool(kind: ToolKind): void;
  sendRegisterAccount(password: string): void;
  /** Task 420: open the chest at `(cx, cy, lx, ly)`. */
  sendOpenChest(cx: number, cy: number, lx: number, ly: number): void;
  /**
   * Task 590: close the chest at `chest` from the player's open-chests
   * set. The server emits one final closing `ChestUpdate` for it.
   */
  sendCloseChest(chest: ChestLocation): void;
  /**
   * Task 070b: ship an `AttackIntent` against `targetKind` / `targetId`.
   * The server validates cooldown / range / self-target / existence; a
   * misbehaving client cannot break invariants here so silent failure on
   * the server side is fine. Bumps the local action seq.
   */
  sendAttackIntent(targetKind: "player" | "entity", targetId: number): void;
  /**
   * Task 200c: ship a `FireBlowgunIntent` against `targetKind` /
   * `targetId`. The server validates blowgun-equipped + dart-in-inventory
   * + range + cooldown + not-self; rejections are silent. Bumps the local
   * action seq.
   */
  sendFireBlowgunIntent(
    targetKind: "player" | "entity",
    targetId: number,
  ): void;
  /**
   * Task 240: ship a `CreateFactionIntent` for the flag at
   * `(cx, cy, lx, ly)` with `name`. The server validates flag-exists,
   * un-claimed, ownership, name shape + uniqueness; rejections are
   * silent. Bumps the local action seq.
   */
  sendCreateFactionIntent(
    cx: number,
    cy: number,
    lx: number,
    ly: number,
    name: string,
  ): void;
}

/**
 * Mirrors `proto::v1::ToolKind`. The wire enum lives in
 * `src/gen/anarchy.js`; we use the numeric codes directly so callers
 * outside the wire bridge don't need to import generated types.
 */
function toolKindToWire(kind: ToolKind): number {
  switch (kind) {
    case "pickaxe":
      return 1;
    case "axe":
      return 2;
    case "utility":
      return 3;
    case "shovel":
      return 4;
    case "sword":
      return 5;
    case "blowgun":
      return 6;
  }
}

/** Pack an optional `ChestLocation` into the wire shape expected by the
 * proto bindings. `null` / `undefined` → omitted field (player grid).
 */
function chestLocToWire(
  loc: ChestLocation | null | undefined,
): { chunkCoord: { cx: number; cy: number }; localX: number; localY: number } | undefined {
  if (loc === null || loc === undefined) return undefined;
  return {
    chunkCoord: { cx: loc.cx, cy: loc.cy },
    localX: loc.lx,
    localY: loc.ly,
  };
}

export function createActionSenders(conn: Connection): ActionSenders {
  let actionSeq = 0;

  return {
    sendMoveIntent(dx, dy) {
      const seq = ++actionSeq;
      conn.send({ action: { moveIntent: { dx, dy }, clientSeq: seq } });
    },
    sendBreakIntent(target) {
      const seq = ++actionSeq;
      if (target === null) {
        conn.send({ breakIntent: { clientSeq: seq } });
      } else {
        conn.send({
          breakIntent: {
            target: {
              chunkCoord: { cx: target.cx, cy: target.cy },
              localX: target.lx,
              localY: target.ly,
            },
            clientSeq: seq,
          },
        });
      }
    },
    sendPlaceBlock(cx, cy, lx, ly) {
      conn.send({
        placeBlock: {
          chunkCoord: { cx, cy },
          localX: lx,
          localY: ly,
        },
      });
    },
    sendSelectSlot(slot) {
      const seq = ++actionSeq;
      conn.send({ selectSlot: { slot, clientSeq: seq } });
    },
    sendMoveSlot(src, dst, srcChest = null, dstChest = null) {
      const seq = ++actionSeq;
      conn.send({
        moveSlot: {
          src,
          dst,
          clientSeq: seq,
          srcChest: chestLocToWire(srcChest),
          dstChest: chestLocToWire(dstChest),
        },
      });
    },
    sendTransferItems(src, dst, count, srcChest = null, dstChest = null) {
      const seq = ++actionSeq;
      conn.send({
        transferItems: {
          src,
          dst,
          count,
          clientSeq: seq,
          srcChest: chestLocToWire(srcChest),
          dstChest: chestLocToWire(dstChest),
        },
      });
    },
    sendCraft(recipeId) {
      const seq = ++actionSeq;
      conn.send({ craft: { recipeId, clientSeq: seq } });
    },
    sendEquipTool(sourceSlot, kind) {
      const seq = ++actionSeq;
      conn.send({
        equipTool: {
          sourceSlot,
          toolKind: toolKindToWire(kind),
          clientSeq: seq,
        },
      });
    },
    sendUnequipTool(kind) {
      const seq = ++actionSeq;
      conn.send({
        unequipTool: { toolKind: toolKindToWire(kind), clientSeq: seq },
      });
    },
    sendRegisterAccount(password) {
      conn.send({ registerAccount: { password } });
    },
    sendOpenChest(cx, cy, lx, ly) {
      const seq = ++actionSeq;
      conn.send({
        openChest: {
          chunkCoord: { cx, cy },
          localX: lx,
          localY: ly,
          clientSeq: seq,
        },
      });
    },
    sendCloseChest(chest) {
      const seq = ++actionSeq;
      conn.send({
        closeChest: {
          clientSeq: seq,
          chest: {
            chunkCoord: { cx: chest.cx, cy: chest.cy },
            localX: chest.lx,
            localY: chest.ly,
          },
        },
      });
    },
    sendAttackIntent(targetKind, targetId) {
      const seq = ++actionSeq;
      conn.send({
        attackIntent: {
          targetKind: targetKindToWire(targetKind),
          targetId,
          clientSeq: seq,
        },
      });
    },
    sendFireBlowgunIntent(targetKind, targetId) {
      const seq = ++actionSeq;
      const payload: {
        clientSeq: number;
        targetPlayerId?: number;
        targetEntityId?: number;
      } = { clientSeq: seq };
      if (targetKind === "player") {
        payload.targetPlayerId = targetId;
      } else {
        payload.targetEntityId = targetId;
      }
      conn.send({ fireBlowgun: payload });
    },
    sendCreateFactionIntent(cx, cy, lx, ly, name) {
      const seq = ++actionSeq;
      conn.send({
        createFaction: {
          chunkCoord: { cx, cy },
          localX: lx,
          localY: ly,
          name,
          clientSeq: seq,
        },
      });
    },
  };
}

/** Mirrors `proto::v1::TargetKind`. */
function targetKindToWire(kind: "player" | "entity"): number {
  return kind === "player" ? 1 : 2;
}
