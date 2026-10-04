import path from "node:path";
import { defineConfig } from "vitest/config";
// Separate acceptance command: never count unexecuted external-provider tests as CI passes.
export default defineConfig({ resolve: { alias: { "@": path.resolve(__dirname, "src") } }, test: {
  environment: "node", include: ["tests/live/**/*.acceptance.ts"], setupFiles: ["tests/setup.ts"],
  testTimeout: 120_000, hookTimeout: 30_000, pool: "forks", poolOptions: { forks: { singleFork: true } },
} });
