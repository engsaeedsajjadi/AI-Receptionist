/**
 * Shared guard for every live acceptance suite.
 *
 * Rules enforced here (not by convention):
 *  - a live suite must never run against a production-looking database, and
 *  - missing provider configuration is a HARD FAILURE, never a skip, so an
 *    explicitly invoked live suite can never report green without evidence.
 *
 * The suites are selected by `vitest.live.config.ts`, which additionally
 * requires TEST_DATABASE_URL and LIVE_TEST_CONFIRM_RESET=yes.
 */

const PRODUCTION_HINTS = /prod|amazonaws\.com|neon\.tech|supabase|azure|rds\.|\.cloud/i;
const DISPOSABLE_HINTS = /test|local|127\.0\.0\.1|localhost|drill|ci-db/i;

export function assertDisposableDatabase(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("Live acceptance unavailable: TEST_DATABASE_URL is not set");
  if (url !== (process.env.DATABASE_URL ?? url) && process.env.DATABASE_URL && process.env.DATABASE_URL !== url) {
    throw new Error("Live acceptance unavailable: DATABASE_URL must equal TEST_DATABASE_URL for live runs");
  }
  if (PRODUCTION_HINTS.test(url) && !DISPOSABLE_HINTS.test(url)) {
    throw new Error("Live acceptance refused: the configured database looks like production, not a disposable test database");
  }
  if (!DISPOSABLE_HINTS.test(url)) {
    throw new Error("Live acceptance unavailable: the database URL does not look disposable (need test/local/127.0.0.1)");
  }
  return url;
}

/** Throws (never skips) when required configuration is missing. */
export function requireLiveEnv(keys: string[], label: string): void {
  assertDisposableDatabase();
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Live acceptance unavailable: ${label} requires ${missing.join(", ")}`);
  }
}

export function requireAnyEnv(keys: string[], label: string): string {
  assertDisposableDatabase();
  const found = keys.find((key) => process.env[key]);
  if (!found) {
    throw new Error(`Live acceptance unavailable: ${label} requires one of ${keys.join(", ")}`);
  }
  return found;
}
