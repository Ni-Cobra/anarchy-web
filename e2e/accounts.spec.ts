import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Browser-driven e2e for the player-accounts flow (ADR 0007). Spawns a
// dedicated server on a non-default port + a unique world name so the
// per-spec accounts file can't pollute the Playwright-managed default on
// `:8080`. The client is pointed at the dedicated port via the
// `?server-port=NNNN` query param (mirrors the existing `?username=` /
// `?stub-terrain=` test-bypass patterns in `main.ts`).
//
// Coverage:
//   1. Lobby renders the two-tab New / Returning state machine and the
//      pre-ADR-0007 reconnect-checkbox is gone (regression guard).
//   2. In-game registration round-trip via the side panel's Register
//      modal; the "Account registered." toast lands and the Register
//      button disappears from the panel.
//   3. Disconnect → reconnect via the Returning form with the correct
//      password reuses the saved `PlayerId` (server's
//      `admit_reconnect` path restores from the dormant pool).
//   4. Reconnect with the wrong password re-renders the lobby with the
//      `password-incorrect` reject message above the form.
//   5. Fresh Hello (New mode) on the registered username re-renders the
//      lobby with the `username-taken-by-registration` message and
//      defaults the next attempt to Returning mode.

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, "..", "..", "anarchy-server");
const WORLDS_DIR = resolve(SERVER_DIR, "worlds");

// `:8092` is reserved for this spec — `:8080` is the Playwright auto-server
// and `:8091` is the persistence spec's dedicated server (`persistence.spec.ts`).
const TEST_PORT = 8092;
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

// Per-spec unique world name so reruns and parallel CI workers cannot
// race each other on the same files. The accounts file is sibling to the
// world file, so a fresh world implies a fresh accounts registry — the
// username can be a stable short string within `MAX_USERNAME_LEN = 16`.
const RUN_TAG = `${process.pid}-${Date.now()}`;
const WORLD_NAME = `e2e-accounts-${RUN_TAG}`;
const WORLD_FILE = resolve(WORLDS_DIR, `${WORLD_NAME}.json`);
const ACCOUNTS_FILE = resolve(WORLDS_DIR, `${WORLD_NAME}.accounts.json`);

const TEST_USERNAME = "accuser";
const TEST_PASSWORD = "secret-pw-12345";
const QUERY = `server-port=${TEST_PORT}`;

interface RunningServer {
  proc: ChildProcessWithoutNullStreams;
  exit: Promise<number | null>;
}

let server: RunningServer | null = null;

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

async function killServer(s: RunningServer): Promise<void> {
  if (s.proc.exitCode !== null) return;
  s.proc.kill("SIGTERM");
  const result = await Promise.race([
    s.exit,
    delay(5000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    s.proc.kill("SIGKILL");
    await s.exit;
  }
}

interface SelfView {
  id: number;
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
      return { id: me.id };
    })
    .then((handle) => handle.jsonValue() as Promise<SelfView>);
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(async () => {
  server = spawnServer();
  await waitForHello();
});

test.afterAll(async () => {
  if (server) {
    await killServer(server);
    server = null;
  }
  for (const f of [
    WORLD_FILE,
    ACCOUNTS_FILE,
    `${WORLD_FILE}.tmp`,
    `${ACCOUNTS_FILE}.tmp`,
  ]) {
    if (existsSync(f)) unlinkSync(f);
  }
});

test("lobby shows the two-tab New / Returning state machine and no reconnect checkbox", async ({
  page,
}) => {
  await page.goto(`/?${QUERY}`);
  await page.waitForSelector("#anarchy-lobby");

  await expect(page.locator("#anarchy-tab-new")).toBeVisible();
  await expect(page.locator("#anarchy-tab-returning")).toBeVisible();
  // New is the default-selected tab.
  await expect(page.locator("#anarchy-tab-new")).toHaveClass(/active/);
  await expect(page.locator("#anarchy-tab-returning")).not.toHaveClass(/active/);

  // Regression guard for the ADR 0007 cleanup: the legacy reconnect
  // checkbox is gone. The lobby has no checkboxes at all today.
  await expect(page.locator("#anarchy-lobby input[type=checkbox]")).toHaveCount(0);

  // Color picker is shown in New mode; password section is hidden.
  await expect(page.locator("#anarchy-color-section")).toBeVisible();
  await expect(page.locator("#anarchy-password-section")).toBeHidden();

  // Switching to Returning hides colors and reveals the password input.
  await page.locator("#anarchy-tab-returning").click();
  await expect(page.locator("#anarchy-color-section")).toBeHidden();
  await expect(page.locator("#anarchy-password-section")).toBeVisible();
  await expect(page.locator("#anarchy-password")).toBeVisible();
});

test("registers in-game and reconnects via the Returning form, retaining the same PlayerId", async ({
  page,
}) => {
  // Skip the lobby for the *first* session via the bypass — we want to
  // exercise the side-panel register flow, not the lobby form here.
  await page.goto(
    `/?${QUERY}&username=${encodeURIComponent(TEST_USERNAME)}&color=0`,
  );
  await page.waitForFunction(() => window.__anarchy !== undefined);
  const meBefore = await waitForSelfSpawn(page);
  expect(meBefore.id).toBeGreaterThan(0);

  // Open the side panel and trigger the register modal.
  await page.locator(".anarchy-side-panel-toggle").click();
  const registerButton = page.locator(".anarchy-side-panel-action", {
    hasText: "Register account",
  });
  await expect(registerButton).toBeVisible();
  await registerButton.click();

  // Modal mounts; fill matching passwords and submit. The submit button
  // stays disabled until both fields agree and meet the min length, so
  // the explicit `expect(...).toBeEnabled()` doubles as a state check.
  await page.waitForSelector("#anarchy-register-modal-root");
  await page.fill("#anarchy-register-pw", TEST_PASSWORD);
  await page.fill("#anarchy-register-pw2", TEST_PASSWORD);
  const submit = page.locator("#anarchy-register-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  // Server's RegisterAccountResult arrives, bootstrap shows the toast and
  // rebuilds the side panel without the Register button.
  await expect(
    page.locator("#anarchy-toast-host", { hasText: "Account registered." }),
  ).toBeVisible();
  await expect(page.locator("#anarchy-register-modal-root")).toHaveCount(0);
  await expect(
    page.locator(".anarchy-side-panel-action", { hasText: "Register account" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".anarchy-side-panel-action", { hasText: "Disconnect" }),
  ).toBeVisible();

  // Disconnect tears the session down; the lobby re-mounts and the
  // `__anarchy` handle clears so the next spawn is unambiguous.
  await page
    .locator(".anarchy-side-panel-action", { hasText: "Disconnect" })
    .click();
  await page.waitForFunction(() => window.__anarchy === undefined);
  await page.waitForSelector("#anarchy-lobby");

  // Sign back in via Returning. The lobby's identity sets `reconnect=true`
  // and ships the password, which routes through `Hub::admit_reconnect` —
  // a matching argon2id verify reuses the saved id from the dormant pool.
  await page.locator("#anarchy-tab-returning").click();
  await page.fill("#anarchy-username", TEST_USERNAME);
  await page.fill("#anarchy-password", TEST_PASSWORD);
  await page.locator("#anarchy-submit").click();

  await page.waitForFunction(() => window.__anarchy !== undefined);
  const meAfter = await waitForSelfSpawn(page);
  expect(meAfter.id).toBe(meBefore.id);
});

test("Returning with the wrong password re-renders the lobby with the password-incorrect message", async ({
  page,
}) => {
  await page.goto(`/?${QUERY}`);
  await page.waitForSelector("#anarchy-lobby");

  await page.locator("#anarchy-tab-returning").click();
  await page.fill("#anarchy-username", TEST_USERNAME);
  await page.fill("#anarchy-password", "wrong-password");
  await page.locator("#anarchy-submit").click();

  // Server replies with LobbyReject(PasswordIncorrect); the lifecycle
  // loop re-mounts the lobby with the reject banner visible.
  await page.waitForFunction(() => {
    const r = document.querySelector<HTMLElement>("#anarchy-reject");
    return (
      r !== null &&
      r.classList.contains("visible") &&
      (r.textContent ?? "").includes("Incorrect password")
    );
  });

  // The lifecycle keeps the user on the Returning tab so they can correct
  // the password without re-clicking the tab.
  await expect(page.locator("#anarchy-tab-returning")).toHaveClass(/active/);
  await expect(page.locator("#anarchy-password-section")).toBeVisible();
  // Username is pre-filled from the prior attempt.
  await expect(page.locator("#anarchy-username")).toHaveValue(TEST_USERNAME);
});

test("fresh Hello (New mode) on the registered username re-renders the lobby with username-taken-by-registration and switches to Returning", async ({
  page,
}) => {
  await page.goto(`/?${QUERY}`);
  await page.waitForSelector("#anarchy-lobby");

  // Default New tab; no password field is shown so the Hello ships
  // `password=""`. The server's `admit_player` path sees a registered
  // username with no password and rejects with
  // `UsernameTakenByRegistration`.
  await expect(page.locator("#anarchy-tab-new")).toHaveClass(/active/);
  await page.fill("#anarchy-username", TEST_USERNAME);
  await page.locator("#anarchy-submit").click();

  await page.waitForFunction(() => {
    const r = document.querySelector<HTMLElement>("#anarchy-reject");
    return (
      r !== null &&
      r.classList.contains("visible") &&
      (r.textContent ?? "").includes("registered")
    );
  });

  // The lifecycle loop forces the Returning tab on this reject so the
  // next attempt prompts for a password without an extra click.
  await expect(page.locator("#anarchy-tab-returning")).toHaveClass(/active/);
  await expect(page.locator("#anarchy-tab-new")).not.toHaveClass(/active/);
  await expect(page.locator("#anarchy-password-section")).toBeVisible();
  await expect(page.locator("#anarchy-username")).toHaveValue(TEST_USERNAME);
});
