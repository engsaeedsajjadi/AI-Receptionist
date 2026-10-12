import path from "node:path";
import { defineConfig } from "vitest/config";
// These tests intentionally reset data. Require an explicitly designated disposable database.
if (!process.env.TEST_DATABASE_URL || process.env.LIVE_TEST_CONFIRM_RESET !== "yes") {
  throw new Error("Set TEST_DATABASE_URL to an isolated disposable database and LIVE_TEST_CONFIRM_RESET=yes before live acceptance");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// Separate acceptance command: never count unexecuted external-provider tests as CI passes.
export default defineConfig({ resolve: { alias: { "@": path.resolve(__dirname, "src") } }, test: {
  environment: "node", include: ["tests/live/**/*.acceptance.ts"], setupFiles: ["tests/setup.ts"],
  testTimeout: 120_000, hookTimeout: 30_000, pool: "forks", poolOptions: { forks: { singleFork: true } },
} });
