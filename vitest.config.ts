import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    coverage: { provider: "v8", include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"], reporter: ["text", "json-summary", "html"], thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 } },
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
