import { beforeAll } from "vitest";

// Test environment defaults. Unit tests only need a syntactically valid env,
// so a dummy DATABASE_URL is injected when no real one is provided.
// Integration tests run only when a REAL database is configured (see
// tests/helpers/db.ts) and skip gracefully otherwise.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "test";
if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/vitest_dummy";
  process.env.VITEST_DUMMY_DB = "1";
}
process.env.APP_URL ??= "http://localhost:3000";

beforeAll(async () => {
  const { resetEnvCache } = await import("@/lib/env");
  resetEnvCache();
});
