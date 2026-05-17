import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminGiveItem,
  adminSpawnEntity,
  adminTeleport,
} from "./admin";

// Task 070b e2e: real-click PvP / PvE / miss / bare-hand. Replaces /
// supplements the admin-driven scenarios in `attack.spec.ts` — those
// pinned the server pipeline through the admission endpoints; these
// drive the client target-pick + beam render + dash lerp + cooldown
// UI end-to-end via actual `mousedown` events.

const CHARGE_MS = 700;
const RESOLUTION_PAD_MS = 800;
// Defaults from `playwright.config.ts` viewport — the helper reads the
// runtime viewport size and falls back to these only if Playwright ever
// changes its default. Pinned here so the camera↔NDC math reads inline.
const DEFAULT_VIEW_W = 1280;
const DEFAULT_VIEW_H = 720;
// Mirrors `crate::config::SPEED` and `CAMERA_HEIGHT` / `CAMERA_FOV` —
// the top-down camera floats `CAMERA_HEIGHT = 14` units above the
// local player and is a 60° vertical-FOV perspective camera. The
// half-height at depth `h` is `h * tan(fov/2)`.
const CAMERA_HEIGHT = 14;
const CAMERA_HALF_FOV_TAN = Math.tan((30 * Math.PI) / 180);

interface SelfView {
  id: number;
  x: number;
  y: number;
}

async function openClient(page: Page, username: string): Promise<SelfView> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      if (id === null || id === 0) return null;
      const me = a.world.getPlayer(id);
      if (!me) return null;
      return { id: me.id, x: me.x, y: me.y };
    })
    .then((h) => h.jsonValue() as Promise<SelfView>);
}

/**
 * Compute the screen-space client coords (clientX, clientY) at which a
 * world tile-centre `(wx, wy)` projects, given the local player sits
 * at `(meX, meY)` and the camera follows them with the standard
 * top-down preset (`CAMERA_HEIGHT = 14`, FOV 60°, up = (0, 0, -1)).
 *
 * Reads the live viewport from Playwright; defaults to 1280×720 if it
 * ever stops returning one (Playwright always sets one in our config).
 */
function projectWorldToClient(
  viewportW: number,
  viewportH: number,
  meX: number,
  meY: number,
  wx: number,
  wy: number,
): { x: number; y: number } {
  const halfHeight = CAMERA_HEIGHT * CAMERA_HALF_FOV_TAN;
  const halfWidth = halfHeight * (viewportW / viewportH);
  const dx = wx - meX;
  const dy = wy - meY;
  // NDC `(x, y)`: `x` left-right (world +x), `y` up-down (world +y).
  const ndcX = dx / halfWidth;
  const ndcY = dy / halfHeight;
  const clientX = ((ndcX + 1) / 2) * viewportW;
  const clientY = ((1 - ndcY) / 2) * viewportH;
  return { x: clientX, y: clientY };
}

/** Compute client coords for a world target seen from the local player. */
async function clientCoordsForTarget(
  page: Page,
  wx: number,
  wy: number,
): Promise<{ x: number; y: number }> {
  const vp = page.viewportSize() ?? { width: DEFAULT_VIEW_W, height: DEFAULT_VIEW_H };
  const me = await page.evaluate(() => {
    const a = window.__anarchy!;
    const id = a.getLocalPlayerId();
    const p = id === null ? null : a.world.getPlayer(id);
    return p ? { x: p.x, y: p.y } : null;
  });
  if (me === null) throw new Error("local player not admitted yet");
  return projectWorldToClient(vp.width, vp.height, me.x, me.y, wx, wy);
}

/**
 * Click on the spider with id `spiderId` atomically — finds the
 * spider's current tile, projects it to client coords, and dispatches
 * a `mousedown` + `mouseup` in one synchronous browser-side call so
 * the spider's per-tick random walk cannot move it out from under the
 * cursor between read and click. Returns `false` if the spider isn't
 * in any loaded chunk.
 */
async function realClickSpider(
  page: Page,
  spiderId: number,
): Promise<boolean> {
  const vp = page.viewportSize() ?? { width: DEFAULT_VIEW_W, height: DEFAULT_VIEW_H };
  return await page.evaluate(
    ({ sid, vw, vh, cameraHeight, halfFovTan }) => {
      const a = window.__anarchy!;
      let pos: { x: number; y: number } | null = null;
      for (const [, chunk] of a.terrain.iter()) {
        const e = chunk.entities.get(sid);
        if (e) {
          pos = { x: e.tileX + 0.5, y: e.tileY + 0.5 };
          break;
        }
      }
      if (pos === null) return false;
      const id = a.getLocalPlayerId();
      const me = id === null ? null : a.world.getPlayer(id);
      if (!me) return false;
      const halfHeight = cameraHeight * halfFovTan;
      const halfWidth = halfHeight * (vw / vh);
      const ndcX = (pos.x - me.x) / halfWidth;
      const ndcY = (pos.y - me.y) / halfHeight;
      const clientX = ((ndcX + 1) / 2) * vw;
      const clientY = ((1 - ndcY) / 2) * vh;
      window.dispatchEvent(
        new MouseEvent("mousedown", {
          button: 0,
          clientX,
          clientY,
          bubbles: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          button: 0,
          clientX,
          clientY,
          bubbles: true,
        }),
      );
      return true;
    },
    {
      sid: spiderId,
      vw: vp.width,
      vh: vp.height,
      cameraHeight: CAMERA_HEIGHT,
      halfFovTan: CAMERA_HALF_FOV_TAN,
    },
  );
}

/** Grant `itemId` to `playerId`, equip the cell into the sword slot. */
async function adminGrantAndEquipSword(
  page: Page,
  playerId: number,
  itemId: number,
): Promise<void> {
  await adminGiveItem(playerId, itemId as 44, 1);
  await page.waitForFunction(
    (id: number) => window.__anarchy!.inventory.countOf(id) === 1,
    itemId,
  );
  const slot = await page.evaluate((id: number) => {
    const inv = window.__anarchy!.inventory;
    for (let i = 0; i < 45; i++) {
      const s = inv.slot(i);
      if (s !== null && s.item === id) return i;
    }
    return -1;
  }, itemId);
  if (slot < 0) {
    throw new Error(`sword item ${itemId} not found in inventory after grant`);
  }
  await page.evaluate(
    (s: number) => window.__anarchy!.sendEquipTool(s, "sword"),
    slot,
  );
  await page.waitForFunction(
    () => window.__anarchy!.inventory.getEquippedSlot("sword") !== null,
  );
}

async function readRemoteHp(page: Page, id: number): Promise<number | null> {
  return await page.evaluate((pid: number) => {
    const p = window.__anarchy!.world.getPlayer(pid);
    return p ? p.health : null;
  }, id);
}

test("real-click PvP: A clicks B in range with wood sword, B HP drops by 15 and A is on cooldown", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "atkc-pvp-a");
    const meB = await openClient(b, "atkc-pvp-b");

    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);
    // Wait for A to see B's authoritative position post-teleport so the
    // projection math lines up with the world the client is rendering.
    await a.waitForFunction(
      (id: number) => {
        const p = window.__anarchy!.world.getPlayer(id);
        return p !== undefined && Math.abs(p.x - 2.5) < 0.1 && Math.abs(p.y - 0.5) < 0.1;
      },
      meB.id,
    );

    await adminGrantAndEquipSword(a, meA.id, AdminItemId.WoodSword);

    // Wait one renderer frame so the player mesh for B exists in A's
    // scene (the picker raycasts against the mesh set).
    await a.waitForFunction(
      (id: number) => {
        const a = window.__anarchy!;
        return a.world.getPlayer(id) !== undefined;
      },
      meB.id,
    );

    const clickAt = await clientCoordsForTarget(a, 2.5, 0.5);
    await a.mouse.click(clickAt.x, clickAt.y);

    // Charge-started should appear in A's scene as a live beam.
    await a.waitForFunction(
      () => window.__anarchy!.getAttackBeamCount() === 1,
      undefined,
      { timeout: 1_000 },
    );

    // After the 0.7 s charge: B HP drops by 15 on both sides.
    await Promise.all([
      a.waitForFunction(
        (id: number) => window.__anarchy!.world.getPlayer(id)?.health === 85,
        meB.id,
        { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
      ),
      b.waitForFunction(
        () => {
          const a = window.__anarchy!;
          const id = a.getLocalPlayerId();
          if (id === null) return false;
          return a.world.getPlayer(id)?.health === 85;
        },
        undefined,
        { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
      ),
    ]);

    // Beam retired post-strike.
    await a.waitForFunction(
      () => window.__anarchy!.getAttackBeamCount() === 0,
      undefined,
      { timeout: 1_000 },
    );

    // Cooldown affordance is active for the local player.
    const cooldownMs = await a.evaluate(
      () => window.__anarchy!.getLocalCooldownStartedMs(),
    );
    expect(cooldownMs).not.toBeNull();

    // Task 140: the cooldown affordance is the sword-slot ring, not the
    // old bottom-right badge. The ring must appear quickly on the sword
    // slot, and the legacy badge must not exist in the DOM at all.
    await a.waitForFunction(() => {
      const ring = document.querySelector(
        ".anarchy-equipment-slot-sword .anarchy-sword-cooldown-ring",
      );
      return ring !== null && ring.classList.contains("active");
    }, undefined, { timeout: 500 });
    const legacyBadge = await a.evaluate(
      () => document.getElementById("anarchy-attack-cooldown") !== null,
    );
    expect(legacyBadge).toBe(false);

    // A second left-click within the 5 s cooldown window does nothing —
    // server silently rejects the intent; B's HP stays at 85.
    const click2 = await clientCoordsForTarget(a, 2.5, 0.5);
    await a.mouse.click(click2.x, click2.y);
    await a.waitForTimeout(CHARGE_MS + RESOLUTION_PAD_MS);
    expect(await readRemoteHp(a, meB.id)).toBe(85);

    // After the 5 s cooldown elapses the ring hides again. Strike fired
    // at roughly `cooldownMs`; wait past `cooldownMs + 5 s` plus a small
    // rAF-tick slack.
    await a.waitForFunction(() => {
      const ring = document.querySelector(
        ".anarchy-equipment-slot-sword .anarchy-sword-cooldown-ring",
      );
      return ring !== null && !ring.classList.contains("active");
    }, undefined, { timeout: 6_000 });

    // Drive a second strike to confirm the ring re-activates cleanly on
    // a fresh strike (not a stale one-shot affordance). Re-teleport B
    // back in range — the first hit dashes A forward but leaves B at
    // (2.5, 0.5); we re-pin both to keep the projection deterministic.
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);
    await a.waitForFunction(
      (id: number) => {
        const me = window.__anarchy!.world.getPlayer(
          window.__anarchy!.getLocalPlayerId()!,
        );
        const them = window.__anarchy!.world.getPlayer(id);
        return (
          me !== undefined &&
          Math.abs(me.x - 0.5) < 0.1 &&
          them !== undefined &&
          Math.abs(them.x - 2.5) < 0.1
        );
      },
      meB.id,
    );
    const firstStrikeMs = cooldownMs!;
    await a.evaluate(
      (id: number) => window.__anarchy!.sendAttackIntent("player", id),
      meB.id,
    );
    await a.waitForFunction(
      (prev: number) => {
        const next = window.__anarchy!.getLocalCooldownStartedMs();
        return next !== null && next !== prev;
      },
      firstStrikeMs,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );
    await a.waitForFunction(() => {
      const ring = document.querySelector(
        ".anarchy-equipment-slot-sword .anarchy-sword-cooldown-ring",
      );
      return ring !== null && ring.classList.contains("active");
    }, undefined, { timeout: 500 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("real-click PvE: wood-sword swing drops a spider's HP by 15", async ({
  browser,
}) => {
  // One real-click confirming the wire end-to-end (target-pick → admit
  // → strike → damage). The two-hit-kill scenario is covered by the
  // admin-driven `attack.spec.ts` PvE spec; here we focus on the
  // single-click branch because a second real click after the 5 s
  // cooldown wait is brittle against camera-lag-vs-authoritative-
  // position when the post-strike dash + snapshot buffer interpolation
  // are still settling — out of scope for this iteration.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "atkc-pve");
    await adminTeleport(me.id, 0.5, 0.5);
    await adminGrantAndEquipSword(page, me.id, AdminItemId.WoodSword);

    const spiderId = await adminSpawnEntity("spider", 2, 0);
    expect(spiderId).toBeGreaterThan(0);
    await page.waitForFunction(
      (id: number) => window.__anarchy!.getRenderedEntities()[id] !== undefined,
      spiderId,
    );

    // Atomic real-click on the spider — spiders random-walk every tick,
    // so the tile read + projection + mousedown must happen in one
    // synchronous browser-side step.
    expect(await realClickSpider(page, spiderId)).toBe(true);

    // Wood sword = 15 dmg. Spider max HP = 20 → post-strike HP = 5.
    await page.waitForFunction(
      (id: number) => {
        const t = window.__anarchy!.terrain;
        for (const [, chunk] of t.iter()) {
          const e = chunk.entities.get(id);
          if (e && e.health === 5) return true;
        }
        return false;
      },
      spiderId,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );
  } finally {
    await ctx.close();
  }
});

test("real-click out-of-reach miss: target walks away mid-charge, no damage, attacker dashed", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "atkc-miss-a");
    const meB = await openClient(b, "atkc-miss-b");
    await adminTeleport(meA.id, 0.5, 0.5);
    await adminTeleport(meB.id, 2.5, 0.5);
    await a.waitForFunction(
      (id: number) => {
        const p = window.__anarchy!.world.getPlayer(id);
        return p !== undefined && Math.abs(p.x - 2.5) < 0.1;
      },
      meB.id,
    );
    await adminGrantAndEquipSword(a, meA.id, AdminItemId.WoodSword);

    // Capture A's pre-strike position so we can assert the dash moved
    // them along the original click direction.
    const preDashAx = await a.evaluate(() => {
      const aH = window.__anarchy!;
      const id = aH.getLocalPlayerId();
      const me = id === null ? null : aH.world.getPlayer(id);
      return me ? me.x : NaN;
    });

    const clickAt = await clientCoordsForTarget(a, 2.5, 0.5);
    await a.mouse.click(clickAt.x, clickAt.y);

    // Mid-charge: yank B to ~30 east — far beyond STRIKE_RANGE = 4.
    await a.waitForFunction(
      () => window.__anarchy!.getAttackBeamCount() === 1,
    );
    await adminTeleport(meB.id, 30.5, 0.5);

    // After charge resolves: B is unchanged (still 100 HP); A dashed
    // toward the original click direction (+x) by ~2 tiles.
    await a.waitForFunction(
      () => window.__anarchy!.getLastAttackEvent()?.outcome === "strike-missed",
      undefined,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );
    expect(await readRemoteHp(a, meB.id)).toBe(100);

    const postDashAx = await a.evaluate(() => {
      const aH = window.__anarchy!;
      const id = aH.getLocalPlayerId();
      const me = id === null ? null : aH.world.getPlayer(id);
      return me ? me.x : NaN;
    });
    // Dash distance is server-side MISS_DASH_TILES (= 2.0); allow a
    // generous slack for collision-aware clamping.
    expect(postDashAx).toBeGreaterThan(preDashAx + 0.5);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("real-click bare-hand attack on a spider drops its HP by 5", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "atkc-bare");
    await adminTeleport(me.id, 0.5, 0.5);

    const spiderId = await adminSpawnEntity("spider", 2, 0);
    expect(spiderId).toBeGreaterThan(0);
    await page.waitForFunction(
      (id: number) => {
        const t = window.__anarchy!.terrain;
        for (const [, chunk] of t.iter()) {
          if (chunk.entities.get(id)?.health === 20) return true;
        }
        return false;
      },
      spiderId,
    );

    expect(await realClickSpider(page, spiderId)).toBe(true);

    await page.waitForFunction(
      (id: number) => {
        const t = window.__anarchy!.terrain;
        for (const [, chunk] of t.iter()) {
          if (chunk.entities.get(id)?.health === 15) return true;
        }
        return false;
      },
      spiderId,
      { timeout: CHARGE_MS + RESOLUTION_PAD_MS },
    );
  } finally {
    await ctx.close();
  }
});
