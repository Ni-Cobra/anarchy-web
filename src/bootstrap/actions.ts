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

import type { ToolKind } from "../game/index.js";
import type { Connection } from "../net/index.js";

export interface ActionSenders {
  sendMoveIntent(dx: number, dy: number): void;
  sendBreakIntent(
    target: { cx: number; cy: number; lx: number; ly: number } | null,
  ): void;
  sendPlaceBlock(cx: number, cy: number, lx: number, ly: number): void;
  sendSelectSlot(slot: number): void;
  sendMoveSlot(src: number, dst: number): void;
  sendCraft(recipeId: string): void;
  sendEquipTool(sourceSlot: number, kind: ToolKind): void;
  sendUnequipTool(kind: ToolKind): void;
  sendRegisterAccount(password: string): void;
}

/**
 * Mirrors `proto::v1::ToolKind`. The wire enum lives in
 * `src/gen/anarchy.js`; we use the numeric codes directly so callers
 * outside the wire bridge don't need to import generated types.
 */
function toolKindToWire(kind: ToolKind): number {
  return kind === "pickaxe" ? 1 : 2;
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
    sendMoveSlot(src, dst) {
      const seq = ++actionSeq;
      conn.send({ moveSlot: { src, dst, clientSeq: seq } });
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
  };
}
