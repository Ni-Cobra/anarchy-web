import { test, expect, type Page } from "./test-shared";

import {
  AdminItemId,
  adminDamagePlayer,
  adminEquipTool,
  adminGiveItem,
  adminGrantXp,
  adminSetBlock,
  adminTeleport,
} from "./admin";

// Task 210 e2e: XP earned by breaking ore + PvP transfer + HUD label.
//
// Two scenarios:
//   1. Player A breaks an Iron Ore tile with an Iron Pickaxe equipped — the
//      `XP: N` label above A's hotbar surfaces "XP: 2".
//   2. Player B is granted 10 XP via the admin shim. Player A lands a PvP
//      kill on B (via the `?killer=` form of `/admin/damage-player`). After
//      respawn A's HUD reads "XP: 10" and B's HUD reads "XP: 0".

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

async function readXpLabel(
  page: Page,
): Promise<{ visible: boolean; text: string | null }> {
  return await page.evaluate(() => {
    const root = document.getElementById("anarchy-xp-label");
    if (!root) return { visible: false, text: null };
    return {
      visible: !root.classList.contains("hidden"),
      text: root.textContent,
    };
  });
}

async function waitForXpLabel(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    (label) => {
      const root = document.getElementById("anarchy-xp-label");
      if (!root) return false;
      if (root.classList.contains("hidden")) return false;
      return root.textContent === label;
    },
    expected,
    { timeout: 8_000 },
  );
}

test("breaking an iron ore grants XP and updates the HUD label", async ({
  browser,
}) => {
  // Iron Ore durability = 180; Iron Pickaxe damage = 7/tick → ~26 ticks
  // (~1.3 s at 20 Hz). The iron tier clears Iron Ore's gate.
  // Plant the ore on chunk (0, 0) local (2, 0): tile center (2.5, 0.5);
  // from the spawn at (0.5, 0.5) that's distance 2.0, well in reach (4.0).
  await adminSetBlock(0, 0, "top", 2, 0, "iron_ore");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "xp-ore");
    await adminTeleport(me.id, 0.5, 0.5);

    // Drop an Iron Pickaxe into the inventory and equip it; the auto-equip
    // path picks the first free pickaxe slot. Adding a small stack of
    // Iron blocks too so a future spec can branch on inventory state if
    // it needs to without re-seeding.
    await adminGiveItem(me.id, AdminItemId.IronPickaxe, 1);
    // The pickaxe lands in the first free slot; on a fresh testing-mode
    // admit the inventory starts with starter Gold in slot 0, so the
    // pickaxe lands at slot 1. Equip via the admin shim.
    const ironPickaxeId: number = AdminItemId.IronPickaxe;
    await page.waitForFunction(
      (id: number) => window.__anarchy!.inventory.countOf(id) === 1,
      ironPickaxeId,
      { timeout: 5_000 },
    );
    const pickaxeSlot = await page.evaluate((id: number) => {
      const inv = window.__anarchy!.inventory;
      for (let i = 0; i < 45; i++) {
        const s = inv.slot(i);
        if (s && s.item === id) return i;
      }
      return -1;
    }, ironPickaxeId);
    expect(pickaxeSlot).toBeGreaterThanOrEqual(0);
    await adminEquipTool(me.id, "pickaxe", pickaxeSlot);

    // The XP label should surface at "XP: 0" — the player has spawned.
    await waitForXpLabel(page, "XP: 0");

    // Wait for the IronOre to land in the player's terrain mirror.
    // BlockType.IronOre = 19 on the wire.
    await page.waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(0, 0);
      if (!chunk) return false;
      const idx = 0 * 16 + 2;
      return chunk.top.blocks[idx]?.kind === 19;
    });

    // Drive the held-break.
    await page.evaluate(() =>
      window.__anarchy!.sendBreakIntent({ cx: 0, cy: 0, lx: 2, ly: 0 }),
    );

    // Wait for the ore to clear and the XP label to bump to 2.
    await page.waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(0, 0);
      if (!chunk) return false;
      const idx = 0 * 16 + 2;
      return chunk.top.blocks[idx]?.kind === 0;
    });
    await waitForXpLabel(page, "XP: 2");
    await page.evaluate(() => window.__anarchy!.sendBreakIntent(null));
  } finally {
    await ctx.close();
    // Defensive cleanup: reset the seeded cell so later specs that pass
    // through chunk (0, 0) start clean.
    await adminSetBlock(0, 0, "top", 2, 0, "air").catch(() => {});
  }
});

test("PvP kill transfers victim's XP to the killer and resets the victim to 0", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    const meA = await openClient(a, "xp-killer");
    const meB = await openClient(b, "xp-victim");

    // Both readouts surface at XP: 0.
    await waitForXpLabel(a, "XP: 0");
    await waitForXpLabel(b, "XP: 0");

    // Plant 10 XP on B. The next tick reships B's snapshot, which the
    // local HUD reads.
    await adminGrantXp(meB.id, 10);
    await waitForXpLabel(b, "XP: 10");

    // Admin-damage B with A as the attributed killer. The server runs
    // the death pipeline via `DeathCause::Pvp { killer: A }`, transferring
    // the 10 XP from B → A and zeroing B's xp on respawn.
    const outcome = await adminDamagePlayer(meB.id, 9999, meA.id);
    expect(outcome.kind).toBe("killed");

    // A's HUD now reads XP: 10; B's HUD reads XP: 0.
    await waitForXpLabel(a, "XP: 10");
    await waitForXpLabel(b, "XP: 0");

    // Quick spot-read just to confirm the labels are still visible (the
    // post-respawn HUD shouldn't have hidden the label).
    const aRead = await readXpLabel(a);
    expect(aRead.visible).toBe(true);
    expect(aRead.text).toBe("XP: 10");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
