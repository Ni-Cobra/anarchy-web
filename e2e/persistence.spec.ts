import { test, expect } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// End-to-end save / load round-trip — exercises ADR 0004's persistence
// contract through the production cargo binary: spawn a server with
// `--world <name>` on a non-default port (so it cannot collide with the
// Playwright-managed default on :8080), seed a known top-layer block via
// the `/debug/seed-top-block` shim, trigger `/debug/save`, kill the
// process, then spawn a fresh server with the same `--world`. The
// post-restart server's in-memory world must still carry the seed — we
// prove that by triggering another `/debug/save` and parsing the
// resulting `<world>.json` file: if the load path lost the block, the
// resave would clobber it from the file too. Reusing the existing save
// shim is a deliberate constraint — Playwright cannot drive stdin into
// the server's rustyline prompt cleanly (the BACKLOG entry calls this out
// explicitly), so the HTTP shim stands in for the CLI `save` command.
//
// `--port` is part of the server's operator-facing CLI surface (see
// `cargo run -- --help`); we use it here so this spec can manage its own
// server lifecycle without taking down the Playwright-managed one — the
// binary listens on `0.0.0.0:<port>` so a parallel default server on
// :8080 stays untouched.

const TEST_PORT = 8091;
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_DIR = resolve(HERE, "..", "..", "anarchy-server");
const WORLDS_DIR = resolve(SERVER_DIR, "worlds");

// Per-spec unique world name so reruns and parallel CI workers cannot
// race each other on the same `<name>.json` file.
const WORLD_NAME = `e2e-persistence-${process.pid}-${Date.now()}`;
const WORLD_FILE = resolve(WORLDS_DIR, `${WORLD_NAME}.json`);

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
        // Quiet the tracing logs so the test output stays readable.
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

async function seedTopBlock(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  kind: string,
): Promise<void> {
  const url = `${TEST_BASE}/debug/seed-top-block/${cx}/${cy}/${lx}/${ly}/${kind}`;
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    throw new Error(`seed failed: ${r.status} ${r.statusText}`);
  }
}

async function triggerSave(): Promise<void> {
  const r = await fetch(`${TEST_BASE}/debug/save`, { method: "POST" });
  if (!r.ok) {
    throw new Error(`save failed: ${r.status} ${r.statusText}`);
  }
}

async function killServer(server: RunningServer): Promise<void> {
  if (server.proc.exitCode !== null) return;
  server.proc.kill("SIGTERM");
  // Give the process a moment to exit cleanly; SIGKILL if it lingers.
  const result = await Promise.race([server.exit, delay(5000).then(() => "timeout")]);
  if (result === "timeout") {
    server.proc.kill("SIGKILL");
    await server.exit;
  }
}

interface SavedWorld {
  version: number;
  world_name: string;
  chunks: Record<string, { ground: string[]; top: string[]; players?: unknown }>;
}

function readSavedWorld(): SavedWorld {
  const raw = readFileSync(WORLD_FILE, "utf8");
  return JSON.parse(raw) as SavedWorld;
}

// We seed at chunk (0, 0), local (5, 6) — well inside the four startup
// default chunks the server pins loaded, so the chunk is guaranteed
// present from the moment the server boots.
const SEED_CX = 0;
const SEED_CY = 0;
const SEED_LX = 5;
const SEED_LY = 6;
const SEED_KIND = "wood";
// Layer is a flat 16-block-wide array indexed `idx = ly * 16 + lx`.
const SEED_INDEX = SEED_LY * 16 + SEED_LX;

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterAll(async () => {
  if (existsSync(WORLD_FILE)) {
    unlinkSync(WORLD_FILE);
  }
  // Atomic-write tmp file may also be left behind in pathological
  // failure modes; sweep it too so re-runs stay clean.
  const tmp = `${WORLD_FILE}.tmp`;
  if (existsSync(tmp)) {
    unlinkSync(tmp);
  }
});

test("save / load round-trip preserves a seeded top-layer block across restart", async () => {
  // ---- First server: seed + save ----
  let server = spawnServer();
  try {
    await waitForHello();
    await seedTopBlock(SEED_CX, SEED_CY, SEED_LX, SEED_LY, SEED_KIND);
    await triggerSave();

    // Sanity: the save produced a real JSON file with the seeded block in
    // the right cell. If this fails, the load-side test below cannot tell
    // us anything new.
    expect(existsSync(WORLD_FILE), "save should have created the world file").toBe(true);
    const firstSave = readSavedWorld();
    expect(firstSave.version).toBe(1);
    expect(firstSave.world_name).toBe(WORLD_NAME);
    const seededChunk = firstSave.chunks[`${SEED_CX}_${SEED_CY}`];
    expect(seededChunk, `chunk (${SEED_CX}, ${SEED_CY}) missing from save`).toBeDefined();
    // BlockType serializes as kebab-case (server-side `#[serde(rename_all
    // = "kebab-case")]`), so a `Wood` block round-trips through JSON as
    // the literal string "wood". The asymmetric REST seed endpoint
    // already speaks lowercase too — the `kind` path segment is
    // case-folded server-side before the parse.
    expect(seededChunk.top[SEED_INDEX]).toBe("wood");
  } finally {
    await killServer(server);
  }

  // ---- Second server: load same world, re-save, parse ----
  // If the load path dropped the block, the re-save would write an
  // unseeded world over the file and the assertion below would fail.
  server = spawnServer();
  try {
    await waitForHello();
    await triggerSave();
    const reloadSave = readSavedWorld();
    const reloadedChunk = reloadSave.chunks[`${SEED_CX}_${SEED_CY}`];
    expect(reloadedChunk, "chunk lost across restart").toBeDefined();
    expect(
      reloadedChunk.top[SEED_INDEX],
      "seeded block lost across restart — load path dropped the cell",
    ).toBe("wood");
  } finally {
    await killServer(server);
  }
});
