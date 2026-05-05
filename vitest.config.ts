import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Default to a Node environment; UI tests opt in to a DOM via the
    // `// @vitest-environment happy-dom` per-file pragma.
    environment: "node",
  },
});
