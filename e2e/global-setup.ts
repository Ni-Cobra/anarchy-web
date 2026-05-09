import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Wipe the Playwright-managed server's world before each e2e run.
//
// The shared server uses `--world e2e --testing` (see `playwright.config.ts`).
// Task 110's testing-mode flag means the server never reads or writes
// `worlds/e2e.json` (or its `.accounts.json` sibling), so this wipe is
// defensive belt-and-suspenders: if a future change drops `--testing` or
// the wrong world name slips into a spec, the next run starts clean rather
// than inheriting a polluted save.
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
