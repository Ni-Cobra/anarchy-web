import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Task 050 — registered account, no dormant record → admit as a fresh
// spawn keyed to the registered username (instead of a hard
// `ReconnectNoRecord` reject).
//
// Repro the "fresh registration that never finished its first session
// cleanly" scenario:
//   1. Spawn a server with a unique world + accounts pair on a non-default
//      port so the Playwright-managed `:8080` server stays untouched.
//   2. Sign in anonymously via the `?username=` lobby bypass and register
//      the account in-game (the side-panel Register flow). The accounts
//      file is persisted synchronously by `register_async`; the world file
//      is *not* — only `save` / `shutdown` write it.
//   3. SIGKILL the server (skipping the SIGTERM auto-save) so the world
//      file never lands on disk and the live player never goes through
//      `end_session` → no dormant record.
//   4. Spawn a fresh server with the same world + accounts pair. The
//      accounts file is loaded (the username is still registered) but the
//      world starts empty (no dormant pool entry for this username).
//   5. Sign back in via the Returning form with the matching password.
//      Pre-task-050 this rejected with `ReconnectNoRecord`; the fix
//      admits a fresh spawn keyed to the registered username.

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, "..", "..", "anarchy-server");
const WORLDS_DIR = resolve(SERVER_DIR, "worlds");

// `:8080` is Playwright auto-managed, `:8091` is `persistence.spec.ts`,
// `:8092` is `accounts.spec.ts`. `:8093` is reserved for this spec.
const TEST_PORT = 8093;
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

const RUN_TAG = `${process.pid}-${Date.now()}`;
const WORLD_NAME = `e2e-fresh-spawn-${RUN_TAG}`;
const WORLD_FILE = resolve(WORLDS_DIR, `${WORLD_NAME}.json`);
const ACCOUNTS_FILE = resolve(WORLDS_DIR, `${WORLD_NAME}.accounts.json`);

const TEST_USERNAME = "freshspawn";
const TEST_PASSWORD = "secret-pw-12345";
const QUERY = `server-port=${TEST_PORT}`;

interface RunningServer {
  proc: ChildProcessWithoutNullStreams;
  exit: Promise<number | null>;
}

function spawnServer(): RunningServer {
  const proc = spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      `${SERVER_DIR}/Cargo.toml`,
      "--",
      "--world",
      WORLD_NAME,
      "--port",
      String(TEST_PORT),
    ],
    {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? "anarchy_server=warn",
      },
    },
  );
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  const exit: Promise<number | null> = new Promise((res) => {
    proc.once("exit", (code) => res(code));
  });
  return { proc, exit };
}

async function waitForHello(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${TEST_BASE}/hello`);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await delay(200);
  }
  throw new Error(
    `server on ${TEST_BASE} did not come up within ${timeoutMs}ms; last error: ${String(lastErr)}`,
  );
}

// SIGKILL — not SIGTERM. SIGTERM would trigger the auto-save path and
// drop a dormant record into the world file, defeating the test premise.
async function killServer(s: RunningServer): Promise<void> {
  if (s.proc.exitCode !== null) return;
  s.proc.kill("SIGKILL");
  await s.exit;
}

interface SelfView {
  id: number;
  username: string;
}

async function waitForSelfSpawn(page: Page): Promise<SelfView> {
  return await page
    .waitForFunction(() => {
      const a = window.__anarchy;
      if (!a) return null;
      const id = a.getLocalPlayerId();
      if (id === null || id === 0) return null;
      const me = a.world.getPlayer(id);
      if (!me) return null;
      return { id: me.id, username: me.username };
    })
    .then((handle) => handle.jsonValue() as Promise<SelfView>);
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterAll(() => {
  for (const f of [
    WORLD_FILE,
    ACCOUNTS_FILE,
    `${WORLD_FILE}.tmp`,
    `${ACCOUNTS_FILE}.tmp`,
  ]) {
    if (existsSync(f)) unlinkSync(f);
  }
});

test("registered account with no dormant record is admitted as a fresh spawn after SIGKILL restart", async ({
  page,
}) => {
  // ---- First session: anon-spawn, register, SIGKILL ----
  let server = spawnServer();
  try {
    await waitForHello();

    await page.goto(
      `/?${QUERY}&username=${encodeURIComponent(TEST_USERNAME)}&color=0`,
    );
    await page.waitForFunction(() => window.__anarchy !== undefined);
    const meBefore = await waitForSelfSpawn(page);
    expect(meBefore.username).toBe(TEST_USERNAME);

    // Register the account through the in-game side-panel flow. The
    // server's `register_async` writes the accounts file synchronously
    // (atomic write-then-rename), so the toast lands only after the file
    // is on disk.
    await page.locator(".anarchy-side-panel-toggle").click();
    await page
      .locator(".anarchy-side-panel-action", { hasText: "Register account" })
      .click();
    await page.waitForSelector("#anarchy-register-modal-root");
    await page.fill("#anarchy-register-pw", TEST_PASSWORD);
    await page.fill("#anarchy-register-pw2", TEST_PASSWORD);
    await page.locator("#anarchy-register-submit").click();
    await expect(
      page.locator("#anarchy-toast-host", { hasText: "Account registered." }),
    ).toBeVisible();
  } finally {
    await killServer(server);
  }

  // Defensive sweep: SIGKILL never runs the save path, so the world file
  // shouldn't exist — but if a future regression sneaks an early save in,
  // delete it here so the test still proves the fresh-spawn branch
  // rather than the dormant re-hydrate branch.
  if (existsSync(WORLD_FILE)) unlinkSync(WORLD_FILE);
  expect(
    existsSync(ACCOUNTS_FILE),
    "accounts file must survive SIGKILL — registration is the load-bearing precondition",
  ).toBe(true);

  // ---- Second session: fresh server, login via Returning ----
  server = spawnServer();
  try {
    await waitForHello();

    // Open a fresh page so the previous session's `__anarchy` handle is
    // gone and the lobby mounts cleanly.
    await page.goto(`/?${QUERY}`);
    await page.waitForSelector("#anarchy-lobby");

    await page.locator("#anarchy-tab-returning").click();
    await page.fill("#anarchy-username", TEST_USERNAME);
    await page.fill("#anarchy-password", TEST_PASSWORD);
    await page.locator("#anarchy-submit").click();

    // Pre-task-050 this would re-render the lobby with the
    // `ReconnectNoRecord` reject; the fix admits the player as a fresh
    // spawn keyed to the registered username. We assert the post-admit
    // world handle exists and the local player carries the expected name.
    await page.waitForFunction(() => window.__anarchy !== undefined);
    const meAfter = await waitForSelfSpawn(page);
    expect(meAfter.username).toBe(TEST_USERNAME);
    expect(meAfter.id).toBeGreaterThan(0);

    // The lobby should be gone now — we're in-world.
    await expect(page.locator("#anarchy-lobby")).toHaveCount(0);
  } finally {
    await killServer(server);
  }
});
