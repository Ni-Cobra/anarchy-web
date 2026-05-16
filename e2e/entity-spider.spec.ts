import { test, expect, type Page } from "./test-shared";

import { adminSpawnEntity, adminTeleport } from "./admin";

// Task 010-entities client half (020) e2e: spawn a spider near the local
// player via `/admin/spawn-entity`, wait for the next per-client
// `TickUpdate` carrying the host chunk, assert the entity layer rendered
// a mesh at the seeded tile, then wait long enough for the server's 10%
// step gate to fire repeatedly and assert the mesh has moved.
//
// We don't pin a *specific* destination (the spider is a random walk) —
// only that a mesh exists at the seeded tile, and that after the wait
// window the rendered position has changed by at least one tile-width.

// Pick a tile that the seed's spawn chunk reliably hosts. The default
// player spawn drops at `(0.5, 0.5)` (chunk 0,0), so any walkable tile
// in chunk 0,0 will be inside the view window. We park the spider near
// the player to keep the host chunk in view.
const SPIDER_SEED_TILE = { tileX: 4, tileY: 4 } as const;
const PLAYER_SPAWN_TILE = { x: 0.5, y: 0.5 } as const;

async function openClient(page: Page, username: string): Promise<number> {
  await page.goto(`/?username=${username}&color=0`);
  await page.waitForFunction(() => window.__anarchy !== undefined);
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      return id !== null && id !== 0 ? id : null;
    })
    .then((handle) => handle.jsonValue() as Promise<number>);
}

test("spider spawn appears in the entity layer and then moves", async ({
  page,
}) => {
  test.setTimeout(20_000);

  const playerId = await openClient(page, "spider-e2e");

  // Pin the player to a known spawn so the host chunk stays in view
  // across the wait window — the random-walk spider could otherwise
  // wander into a chunk the camera has dropped, and the test would
  // race with chunk unload rather than measure spider motion.
  await adminTeleport(playerId, PLAYER_SPAWN_TILE.x, PLAYER_SPAWN_TILE.y);

  const spiderId = await adminSpawnEntity(
    "spider",
    SPIDER_SEED_TILE.tileX,
    SPIDER_SEED_TILE.tileY,
  );
  expect(spiderId).toBeGreaterThan(0);

  // Wait for the entity to surface in the renderer. The server takes
  // one tick (50 ms) to ship the dirty chunk; allow a generous budget
  // so a slow CI doesn't flake.
  const initialPosition = await page
    .waitForFunction(
      (id) => {
        const a = window.__anarchy;
        if (!a) return null;
        const entities = a.getRenderedEntities();
        return entities[id] ?? null;
      },
      spiderId,
      { timeout: 5_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<{ x: number; z: number }>);

  // The mesh should land *near* the seeded tile centre. We can't pin
  // the exact tile — the spider is a random walker (10% chance per
  // 50 ms tick) and may have already stepped by the time the chunk
  // delivery + first render frame arrives. A few-tile-wide window is
  // a robust upper bound; what matters is the mesh exists at all.
  const seedSceneX = SPIDER_SEED_TILE.tileX + 0.5;
  const seedSceneZ = -(SPIDER_SEED_TILE.tileY + 0.5);
  expect(Math.abs(initialPosition.x - seedSceneX)).toBeLessThanOrEqual(3);
  expect(Math.abs(initialPosition.z - seedSceneZ)).toBeLessThanOrEqual(3);

  // The server steps at 10% per 50 ms tick. Wait ~3 seconds — that's
  // ~60 ticks, so the spider walks ~6 times in expectation. The mesh
  // animates the tile teleport over `ENTITY_STEP_TRANSITION_MS = 150`,
  // so the rendered position is essentially the new tile centre by the
  // time we sample. We pin only that the mesh has moved at all (the
  // random walk could choose any direction or even stand still); a
  // displacement of `>= 0.5` covers the smallest possible step (one
  // tile in any cardinal direction).
  await page.waitForFunction(
    ({ id, start }) => {
      const a = window.__anarchy;
      if (!a) return false;
      const current = a.getRenderedEntities()[id];
      if (!current) return false;
      const dx = current.x - start.x;
      const dz = current.z - start.z;
      return Math.hypot(dx, dz) >= 0.5;
    },
    { id: spiderId, start: initialPosition },
    { timeout: 10_000 },
  );
});
