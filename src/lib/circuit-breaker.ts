import { AppError } from "@/lib/errors";
import { getRedis } from "@/lib/redis";
import { logWarn } from "@/lib/logger";

/**
 * Provider circuit breaker.
 *
 * Purpose: stop hammering a third-party provider that is failing, while keeping
 * the rest of the system honest. When the breaker is open the call fails fast
 * with `PROVIDER_CIRCUIT_OPEN` — it is never converted into a fabricated
 * success, and it is not retried inside the caller's database transaction.
 *
 * Store semantics:
 *  - With Redis configured the state is shared across replicas.
 *  - Without Redis (dev/test/single node) an in-process store is used.
 *  - If the store itself is unavailable, the breaker degrades to `closed`
 *    (requests allowed). This is deliberate: a monitoring/optimisation store
 *    outage must not take every provider integration down with it. Tenant
 *    scoping is enforced elsewhere and always fails closed.
 *
 * Transitions: closed → open after `failureThreshold` consecutive failures;
 * open → half-open after `openSeconds`; half-open → closed on success or → open
 * again on the next failure (with doubled backoff up to `maxOpenSeconds`).
 */

export type BreakerState = "closed" | "open" | "half-open";

export type BreakerDecision = {
  state: BreakerState;
  allowRequest: boolean;
  /** Milliseconds until a half-open probe is allowed (0 when allowed). */
  retryAfterMs: number;
  /** Consecutive failures recorded in the current window. */
  failures: number;
  /** Backoff currently applied when open (ms). */
  openForMs: number;
};

export type BreakerStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  del: (key: string) => Promise<void>;
};

export type BreakerOptions = {
  failureThreshold?: number;
  openSeconds?: number;
  maxOpenSeconds?: number;
  store?: BreakerStore;
  now?: () => number;
};

const DEFAULTS = { failureThreshold: 5, openSeconds: 30, maxOpenSeconds: 600 };

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// --- in-process fallback store (per process; used when Redis is absent) ------
const memory = new Map<string, { value: string; expiresAt: number }>();
/** In-process breaker store (the fallback used whenever Redis is unavailable). */
export const memoryBreakerStore: BreakerStore = {
  async get(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key, value, ttlSeconds) {
    memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
  async del(key) {
    memory.delete(key);
  },
};

/** Clears the persisted state for one breaker (used by tests and operators). */
export async function resetBreaker(name: string, options: BreakerOptions = {}): Promise<void> {
  const store = options.store ?? defaultBreakerStore();
  try {
    await store.del(KEY(name));
  } catch {
    // best effort
  }
  memory.delete(KEY(name));
}

/** Wipes in-process breaker state (tests and worker restarts). */
export function resetBreakerMemory(): void {
  memory.clear();
}

export function defaultBreakerStore(): BreakerStore {
  const redis = getRedis();
  if (!redis) return memoryBreakerStore;
  return {
    get: (key) => redis.get(key).catch(() => null),
    set: async (key, value, ttl) => {
      await redis.set(key, value, "EX", ttl).catch(() => undefined);
    },
    del: async (key) => {
      await redis.del(key).catch(() => undefined);
    },
  };
}

type Persisted = { failures: number; openedAt: number | null; openForMs: number };

const KEY = (name: string) => `breaker:${name}`;

async function read(store: BreakerStore, name: string): Promise<Persisted> {
  try {
    const raw = await store.get(KEY(name));
    if (!raw) return { failures: 0, openedAt: null, openForMs: 0 };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      failures: Number.isFinite(parsed.failures) ? Number(parsed.failures) : 0,
      openedAt: typeof parsed.openedAt === "number" ? parsed.openedAt : null,
      openForMs: Number.isFinite(parsed.openForMs) ? Number(parsed.openForMs) : 0,
    };
  } catch {
    // Unreadable/corrupt state must never block traffic.
    return { failures: 0, openedAt: null, openForMs: 0 };
  }
}

async function write(store: BreakerStore, name: string, value: Persisted, ttlSeconds: number): Promise<void> {
  try {
    await store.set(KEY(name), JSON.stringify(value), ttlSeconds);
  } catch {
    // Best effort: an unreachable store degrades to closed.
  }
}

export async function breakerDecision(name: string, options: BreakerOptions = {}): Promise<BreakerDecision> {
  const failureThreshold = options.failureThreshold ?? envNumber("BREAKER_FAILURE_THRESHOLD", DEFAULTS.failureThreshold);
  const openSeconds = options.openSeconds ?? envNumber("BREAKER_OPEN_SECONDS", DEFAULTS.openSeconds);
  const maxOpenSeconds = options.maxOpenSeconds ?? envNumber("BREAKER_MAX_OPEN_SECONDS", DEFAULTS.maxOpenSeconds);
  const now = options.now?.() ?? Date.now();
  const store = options.store ?? defaultBreakerStore();
  const state = await read(store, name);

  if (state.openedAt === null) {
    return { state: "closed", allowRequest: true, retryAfterMs: 0, failures: state.failures, openForMs: 0 };
  }
  const openForMs = Math.min(state.openForMs || openSeconds * 1000, maxOpenSeconds * 1000);
  const elapsed = now - state.openedAt;
  if (elapsed >= openForMs) {
    return { state: "half-open", allowRequest: true, retryAfterMs: 0, failures: state.failures, openForMs };
  }
  return {
    state: "open",
    allowRequest: false,
    retryAfterMs: openForMs - elapsed,
    failures: state.failures,
    openForMs,
  };
}

export async function recordBreakerSuccess(name: string, options: BreakerOptions = {}): Promise<void> {
  const store = options.store ?? defaultBreakerStore();
  await write(store, name, { failures: 0, openedAt: null, openForMs: 0 }, 60);
}

export async function recordBreakerFailure(name: string, options: BreakerOptions = {}): Promise<BreakerDecision> {
  const failureThreshold = options.failureThreshold ?? envNumber("BREAKER_FAILURE_THRESHOLD", DEFAULTS.failureThreshold);
  const openSeconds = options.openSeconds ?? envNumber("BREAKER_OPEN_SECONDS", DEFAULTS.openSeconds);
  const maxOpenSeconds = options.maxOpenSeconds ?? envNumber("BREAKER_MAX_OPEN_SECONDS", DEFAULTS.maxOpenSeconds);
  const now = options.now?.() ?? Date.now();
  const store = options.store ?? defaultBreakerStore();
  const state = await read(store, name);
  const failures = state.failures + 1;
  const wasOpen = state.openedAt !== null;
  // Exponential backoff once a probe fails, bounded by maxOpenSeconds.
  const openForMs = wasOpen
    ? Math.min(Math.max(state.openForMs, openSeconds * 1000) * 2, maxOpenSeconds * 1000)
    : openSeconds * 1000;
  const willOpen = wasOpen || failures >= failureThreshold;

  if (!willOpen) {
    await write(store, name, { failures, openedAt: null, openForMs: 0 }, Math.max(60, openSeconds * 2));
    return { state: "closed", allowRequest: true, retryAfterMs: 0, failures, openForMs: 0 };
  }

  await write(store, name, { failures, openedAt: now, openForMs }, Math.ceil(maxOpenSeconds + 60));
  logWarn("Provider circuit opened", {
    operation: "circuit.open",
    status: "error",
    provider: name,
    failures,
    openForMs,
  });
  return { state: "open", allowRequest: false, retryAfterMs: openForMs, failures, openForMs };
}

/**
 * Run `fn` under the breaker. Throws `AppError(503, PROVIDER_CIRCUIT_OPEN)` when
 * the breaker is open — the provider is not called at all, so no partial state
 * or fabricated result can escape.
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  options: BreakerOptions & {
    unavailableMessage?: string;
    /**
     * Classify an error as a provider-health failure. Client errors (400/404,
     * validation, rate limits) must not trip the breaker for everyone else.
     */
    shouldCountFailure?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const decision = await breakerDecision(name, options);
  if (!decision.allowRequest) {
    throw new AppError(
      503,
      "PROVIDER_CIRCUIT_OPEN",
      options.unavailableMessage ??
        `Provider ${name} is temporarily unavailable (circuit open, retry in ${Math.ceil(decision.retryAfterMs / 1000)}s)`,
    );
  }
  try {
    const result = await fn();
    await recordBreakerSuccess(name, options);
    return result;
  } catch (error) {
    if (!options.shouldCountFailure || options.shouldCountFailure(error)) {
      await recordBreakerFailure(name, options);
    }
    throw error;
  }
}

export async function breakerSnapshot(names: string[], options: BreakerOptions = {}): Promise<Record<string, BreakerDecision>> {
  const out: Record<string, BreakerDecision> = {};
  for (const name of names) out[name] = await breakerDecision(name, options);
  return out;
}
