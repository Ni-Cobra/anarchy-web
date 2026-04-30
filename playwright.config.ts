import { defineConfig } from "@playwright/test";

const SERVER_URL = "http://localhost:8080";
const VITE_URL = "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: VITE_URL,
  },
  webServer: [
    {
      command: "cargo run --manifest-path ../anarchy-server/Cargo.toml",
      url: `${SERVER_URL}/hello`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort",
      url: VITE_URL,
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
