import Redis from "ioredis";
import { getEnv, isProduction } from "@/lib/env";
import { logWarn } from "@/lib/logger";

let client: Redis | null = null;
let warnedUnavailable = false;

/**
 * Shared Redis client.
 *
 * - Production: REDIS_URL is required (validated in env.ts). Connection
 *   failures are surfaced; readiness checks report unhealthy.
 * - Development/test without REDIS_URL: returns null and callers must use
 *   the in-memory fallback explicitly (never silently in production).
 */
export function getRedis(): Redis | null {
  let url = "";
  try {
    url = getEnv().REDIS_URL;
  } catch {
    url = process.env.REDIS_URL ?? "";
  }
  if (!url) {
    if (isProduction) {
      throw new Error("[redis] REDIS_URL is required in production");
    }
    return null;
  }
  if (!client) {
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    client.on("error", (err) => {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        logWarn("Redis connection error", { operation: "redis.connect", error: String(err) });
      }
    });
  }
  return client;
}

export async function checkRedisHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const redis = getRedis();
  if (!redis) return { ok: false, error: "not_configured" };
  try {
    const start = Date.now();
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "ping_failed" };
  }
}

/** Test-only: close the shared client. */
export async function closeRedis(): Promise<void> {
  if (client) {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
    client = null;
  }
}

// ---------------------------------------------------------------------------
// Distributed primitives (Redis-backed, in-memory fallback for dev/test only)
// ---------------------------------------------------------------------------

type FallbackEntry = { value: string; expiresAt: number };
const fallbackStore = new Map<string, FallbackEntry>();

function fallbackGet(key: string): string | null {
  const entry = fallbackStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    fallbackStore.delete(key);
    return null;
  }
  return entry.value;
}

function fallbackSet(key: string, value: string, ttlSeconds: number): void {
  fallbackStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (fallbackStore.size > 10_000) {
    const oldest = fallbackStore.keys().next().value as string | undefined;
    if (oldest) fallbackStore.delete(oldest);
  }
}

/**
 * Atomic "set if not exists" used for idempotency keys and locks.
 * Returns true if the key was newly set, false if it already existed.
 */
export async function setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const res = await redis.set(key, value, "EX", ttlSeconds, "NX");
    return res === "OK";
  }
  if (isProduction) throw new Error("[redis] Redis unavailable in production");
  if (fallbackGet(key) !== null) return false;
  fallbackSet(key, value, ttlSeconds);
  return true;
}

export async function redisGet(key: string): Promise<string | null> {
  const redis = getRedis();
  if (redis) return redis.get(key);
  if (isProduction) throw new Error("[redis] Redis unavailable in production");
  return fallbackGet(key);
}

export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const redis = getRedis();
  if (redis) {
    if (ttlSeconds) await redis.set(key, value, "EX", ttlSeconds);
    else await redis.set(key, value);
    return;
  }
  if (isProduction) throw new Error("[redis] Redis unavailable in production");
  fallbackSet(key, value, ttlSeconds ?? 3600);
}

export async function redisDel(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.del(key);
    return;
  }
  fallbackStore.delete(key);
}

let lastDegradedWarnAt = 0;

export async function redisIncr(key: string, ttlSeconds: number): Promise<number> {
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, ttlSeconds);
      return count;
    } catch (err) {
      // Redis is reachable for config but the command failed (server down,
      // failover, ...). Rate limiting is a protective control, not a
      // correctness control: degrade to per-process limiting instead of
      // 500ing every request (webhooks MUST stay acceptable, §1). Loud, not
      // silent: warn at most once a minute.
      const now = Date.now();
      if (now - lastDegradedWarnAt > 60_000) {
        lastDegradedWarnAt = now;
        logWarn("Redis command failed; using per-process rate-limit fallback", {
          operation: "redis.degraded",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (isProduction && !redis) throw new Error("[redis] Redis unavailable in production");
  const current = Number(fallbackGet(key) ?? "0") + 1;
  fallbackSet(key, String(current), ttlSeconds);
  return current;
}

/**
 * Simple distributed lock (best-effort). Returns a release function or null
 * when the lock could not be acquired.
 */
export async function acquireLock(key: string, ttlSeconds = 30): Promise<(() => Promise<void>) | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await setNx(`lock:${key}`, token, ttlSeconds);
  if (!acquired) return null;
  return async () => {
    const redis = getRedis();
    if (redis) {
      // Release only if we still own the lock.
      const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      await redis.eval(script, 1, `lock:${key}`, token);
      return;
    }
    if (fallbackGet(`lock:${key}`) === token) fallbackStore.delete(`lock:${key}`);
  };
}
