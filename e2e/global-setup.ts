import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Wipe the Playwright-managed server's world before each e2e run.
//
// The shared server uses `--world e2e` (see `playwright.config.ts`); its
// save files live alongside the dev `default` world but are dedicated to the
// e2e harness. Without this scrub, every successful test run leaves block
// placements, parked players, and account registrations on disk; the next run
// loads the polluted state and any spec that assumes a clean spawn region or
// a fresh accounts registry breaks. Spawn protection only fires at chunk
// generation, so loaded chunks keep whatever the previous run wrote.
//
// `force: true` makes the rm a no-op when the file is absent (first run on a
// fresh checkout). `reuseExistingServer: false` in the config ensures a stale
// in-memory world from a previous server instance can't survive either.

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLDS_DIR = resolve(HERE, "..", "..", "anarchy-server", "worlds");
const E2E_WORLD = "e2e";

export default async function globalSetup(): Promise<void> {
  rmSync(resolve(WORLDS_DIR, `${E2E_WORLD}.json`), { force: true });
  rmSync(resolve(WORLDS_DIR, `${E2E_WORLD}.json.tmp`), { force: true });
  rmSync(resolve(WORLDS_DIR, `${E2E_WORLD}.accounts.json`), { force: true });
}
