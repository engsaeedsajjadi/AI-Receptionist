import { it } from "vitest";
import { getRedis } from "@/lib/redis";

if (process.env.TEST_REDIS_URL && !process.env.REDIS_URL) {
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
}

/** True when Redis-backed E2E tests can run against a REAL server. */
export function hasTestRedis(): boolean {
  return Boolean(process.env.REDIS_URL || process.env.TEST_REDIS_URL);
}

let redisReady: boolean | null = null;

/** Ping the configured Redis once; false when unreachable (enables skip). */
export async function ensureRedisReady(): Promise<boolean> {
  if (redisReady !== null) return redisReady;
  if (!hasTestRedis()) {
    redisReady = false;
    return false;
  }
  try {
    const client = getRedis();
    if (!client) {
      redisReady = false;
      return false;
    }
    await client.ping();
    redisReady = true;
  } catch {
    redisReady = false;
  }
  return redisReady;
}

type TestFn = () => Promise<void> | void;

/**
 * Redis-gated test: skips at runtime when no real Redis is reachable.
 * Use inside describe.skipIf(!hasTestRedis()) suites for a fast path.
 * CI always sets REDIS_URL, so these MUST run there (enforced by
 * scripts/ci/check-test-results.mjs failing on any skipped test).
 */
export function itRedis(name: string, fn: TestFn, timeout?: number): void {
  it(
    name,
    async (ctx) => {
      if (!(await ensureRedisReady())) {
        ctx.skip();
        return;
      }
      await fn();
    },
    timeout,
  );
}
