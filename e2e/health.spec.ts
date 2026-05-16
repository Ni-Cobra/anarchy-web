import { test, expect, type Page } from "./test-shared";

import {
  adminDamageEntity,
  adminDamagePlayer,
  adminSpawnEntity,
  adminTeleport,
} from "./admin";

// Task 060 e2e: HP system + HP bar UI + death pipeline. Covers:
//  - admin damage to the local player shrinks the HP bar fill and re-paints
//    the numeric `HP / 100` overlay.
//  - admin damage to zero runs the death pipeline (tombstone landed at the
//    death tile, inventory cleared, player back to full HP, teleported to
//    a fresh spawn).
//  - admin damage to a spider removes it from the wire (its mesh disappears
//    from the entity layer).

const SPAWN_TILE = { x: 0.5, y: 0.5 } as const;

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

async function readHpBar(
  page: Page,
): Promise<{ visible: boolean; text: string | null; fillPx: number }> {
  return await page.evaluate(() => {
    const root = document.getElementById("anarchy-hp-bar");
    if (!root) return { visible: false, text: null, fillPx: 0 };
    const visible = !root.classList.contains("hidden");
    const text = root.querySelector(".anarchy-hp-text")?.textContent ?? null;
    const fillStyle = (
      root.querySelector(".anarchy-hp-fill") as HTMLElement | null
    )?.style.width ?? "0";
    const fillPx = Number.parseFloat(fillStyle);
    return { visible, text, fillPx };
  });
}

test("HP bar mirrors local player health and shrinks on admin damage", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "hp-bar-test");
    await adminTeleport(me.id, SPAWN_TILE.x, SPAWN_TILE.y);

    // Wait for the HP bar to surface at full HP.
    await page.waitForFunction(() => {
      const text = document.querySelector(
        "#anarchy-hp-bar .anarchy-hp-text",
      )?.textContent;
      return text === "100 / 100";
    });
    const before = await readHpBar(page);
    expect(before.visible).toBe(true);
    expect(before.text).toBe("100 / 100");

    // Hit the player for 50 damage. The next snapshot ships health=50.
    const outcome = await adminDamagePlayer(me.id, 50);
    expect(outcome.kind).toBe("alive");
    if (outcome.kind === "alive") {
      expect(outcome.remainingHealth).toBe(50);
    }

    await page.waitForFunction(() => {
      const text = document.querySelector(
        "#anarchy-hp-bar .anarchy-hp-text",
      )?.textContent;
      return text === "50 / 100";
    });
    const mid = await readHpBar(page);
    // Bar width pinned at 476 px → 50% fill = 238 px.
    expect(mid.fillPx).toBeCloseTo(238, 0);
  } finally {
    await ctx.close();
  }
});

test("admin-damage to zero runs the death pipeline and respawns the player", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "death-pipeline");
    await adminTeleport(me.id, 5.5, 0.5);

    // Take the player from 100 → 0 in one hit. The server runs the death
    // pipeline before the response returns; the client sees the player at
    // full HP again at the new spawn tile on the next snapshot.
    const outcome = await adminDamagePlayer(me.id, 9999);
    expect(outcome.kind).toBe("killed");

    // Player respawns at full HP — the HP bar bounces back to `100 / 100`.
    await page.waitForFunction(() => {
      const text = document.querySelector(
        "#anarchy-hp-bar .anarchy-hp-text",
      )?.textContent;
      return text === "100 / 100";
    });

    // Tombstone landed at the death tile (5, 0) — verify via the terrain
    // mirror. `BlockType.Tombstone === 25` in both server + client enums.
    await page.waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return false;
      const chunk = a.terrain.get(0, 0);
      if (!chunk) return false;
      const idx = 0 * 16 + 5;
      return chunk.top.blocks[idx]?.kind === 25;
    });

    // Inventory cleared post-respawn (the starter loadout from testing
    // mode ships gold/wood/etc into the initial admit; after kill_player
    // the inventory is wiped). Spec only pins that NO non-zero count
    // survives the death pipeline for any item the starter ships.
    const inventoryEmpty = await page.evaluate(() => {
      const inv = window.__anarchy!.inventory;
      // Sum every slot's count; a freshly respawned player has all empty.
      let total = 0;
      for (let i = 0; i < 45; i++) {
        const slot = inv.slot(i);
        if (slot !== null) total += slot.count;
      }
      return total === 0;
    });
    expect(inventoryEmpty).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("admin-damage to a spider removes it from the entity layer", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const me = await openClient(page, "spider-kill");
    await adminTeleport(me.id, SPAWN_TILE.x, SPAWN_TILE.y);

    const spiderId = await adminSpawnEntity("spider", 4, 4);
    expect(spiderId).toBeGreaterThan(0);

    // Wait for the spider mesh to surface in the entity layer.
    await page.waitForFunction(
      (id) => {
        const a = window.__anarchy;
        if (!a) return false;
        const entities = a.getRenderedEntities();
        return entities[id] !== undefined;
      },
      spiderId,
      { timeout: 5_000 },
    );

    // Kill the spider via the admin damage endpoint (spider max HP = 20).
    const outcome = await adminDamageEntity(spiderId, 9999);
    expect(outcome.kind).toBe("killed");

    // The entity mesh should drop on the next chunk fan-out.
    await page.waitForFunction(
      (id) => {
        const a = window.__anarchy;
        if (!a) return false;
        const entities = a.getRenderedEntities();
        return entities[id] === undefined;
      },
      spiderId,
      { timeout: 5_000 },
    );
  } finally {
    await ctx.close();
  }
});
