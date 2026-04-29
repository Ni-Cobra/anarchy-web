import { defineConfig } from "@playwright/test";

const SERVER_URL = "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: "cargo run --manifest-path ../anarchy-server/Cargo.toml",
    url: `${SERVER_URL}/hello`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
