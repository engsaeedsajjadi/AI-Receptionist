import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  breakerDecision,
  breakerSnapshot,
  memoryBreakerStore,
  recordBreakerFailure,
  recordBreakerSuccess,
  resetBreakerMemory,
  withCircuitBreaker,
  type BreakerStore,
} from "@/lib/circuit-breaker";

/**
 * Circuit breaker contract:
 *  - closed until `failureThreshold` consecutive failures,
 *  - open ⇒ the provider is not called at all and the caller gets a 503
 *    `PROVIDER_CIRCUIT_OPEN` (never a fabricated success),
 *  - half-open after the backoff, closing on success and doubling the backoff
 *    when the probe fails,
 *  - client errors (4xx) and health errors (5xx/network) are distinguished,
 *  - an unreadable/corrupt store degrades to closed instead of blocking traffic.
 */

function memoryHarness() {
  const data = new Map<string, string>();
  const store: BreakerStore = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    del: async (key) => {
      data.delete(key);
    },
  };
  return { store, data };
}

describe("circuit breaker", () => {
  beforeEach(() => resetBreakerMemory());
  afterEach(() => {
    resetBreakerMemory();
    vi.restoreAllMocks();
  });

  it("stays closed while calls succeed and exposes a snapshot", async () => {
    const { store } = memoryHarness();
    const fn = vi.fn(async () => "ok");
    await expect(withCircuitBreaker("p1", fn, { store })).resolves.toBe("ok");
    const snapshot = await breakerSnapshot(["p1", "p2"], { store });
    expect(snapshot.p1).toMatchObject({ state: "closed", allowRequest: true, failures: 0 });
    expect(snapshot.p2.state).toBe("closed");
  });

  it("opens after the configured failure threshold and stops calling the provider", async () => {
    const { store } = memoryHarness();
    const provider = vi.fn(async () => {
      throw new AppError(502, "PROVIDER_ERROR", "boom");
    });
    for (let i = 0; i < 2; i += 1) {
      await expect(withCircuitBreaker("p2", provider, { store, failureThreshold: 3 })).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
      });
    }
    expect((await breakerDecision("p2", { store })).state).toBe("closed");

    await expect(withCircuitBreaker("p2", provider, { store, failureThreshold: 3 })).rejects.toBeInstanceOf(AppError);
    const decision = await breakerDecision("p2", { store });
    expect(decision).toMatchObject({ state: "open", allowRequest: false });
    expect(decision.retryAfterMs).toBeGreaterThan(0);

    const callsBefore = provider.mock.calls.length;
    await expect(withCircuitBreaker("p2", provider, { store })).rejects.toMatchObject({
      status: 503,
      code: "PROVIDER_CIRCUIT_OPEN",
    });
    expect(provider.mock.calls.length).toBe(callsBefore); // provider untouched
  });

  it("allows a half-open probe after the backoff and closes on success", async () => {
    const { store } = memoryHarness();
    const now = { value: 1_000_000 };
    const options = { store, failureThreshold: 1, openSeconds: 30, now: () => now.value };
    await expect(
      withCircuitBreaker("p3", async () => {
        throw new AppError(504, "PROVIDER_TIMEOUT", "timeout");
      }, options),
    ).rejects.toBeInstanceOf(AppError);
    expect((await breakerDecision("p3", options)).state).toBe("open");

    // Still inside the backoff window.
    now.value += 1_000;
    expect((await breakerDecision("p3", options)).state).toBe("open");

    // After the window the next call is a probe; success closes the breaker.
    now.value += 30_000;
    expect((await breakerDecision("p3", options)).state).toBe("half-open");
    await expect(withCircuitBreaker("p3", async () => "recovered", options)).resolves.toBe("recovered");
    expect((await breakerDecision("p3", options)).state).toBe("closed");
  });

  it("doubles the backoff when a half-open probe fails, bounded by maxOpenSeconds", async () => {
    const { store } = memoryHarness();
    const now = { value: 0 };
    const options = { store, failureThreshold: 1, openSeconds: 10, maxOpenSeconds: 25, now: () => now.value };
    const failing = async () => {
      throw new AppError(502, "PROVIDER_ERROR", "down");
    };

    await expect(withCircuitBreaker("p4", failing, options)).rejects.toBeInstanceOf(AppError);
    expect((await breakerDecision("p4", options)).openForMs).toBe(10_000);

    now.value += 10_000;
    await expect(withCircuitBreaker("p4", failing, options)).rejects.toBeInstanceOf(AppError);
    const second = await breakerDecision("p4", options);
    expect(second.openForMs).toBe(20_000);

    now.value += 20_000;
    await expect(withCircuitBreaker("p4", failing, options)).rejects.toBeInstanceOf(AppError);
    const third = await breakerDecision("p4", options);
    expect(third.openForMs).toBe(25_000); // capped
    expect(third.failures).toBe(3);
  });

  it("does not count client errors when the caller supplies a classifier", async () => {
    const { store } = memoryHarness();
    const shouldCountFailure = (error: unknown) => !(error instanceof AppError && error.status < 500);
    for (let i = 0; i < 5; i += 1) {
      await expect(
        withCircuitBreaker(
          "p5",
          async () => {
            throw new AppError(400, "INVALID_PAYLOAD", "bad request");
          },
          { store, failureThreshold: 2, shouldCountFailure },
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect((await breakerDecision("p5", { store })).state).toBe("closed");
    expect((await breakerDecision("p5", { store })).failures).toBe(0);
  });

  it("degrades to closed when the store is unreadable", async () => {
    const brokenStore: BreakerStore = {
      get: async () => {
        throw new Error("store down");
      },
      set: async () => {
        throw new Error("store down");
      },
      del: async () => undefined,
    };
    const decision = await breakerDecision("p6", { store: brokenStore });
    expect(decision.allowRequest).toBe(true);
    await expect(withCircuitBreaker("p6", async () => "still works", { store: brokenStore })).resolves.toBe("still works");
  });

  it("recovers from corrupt persisted state instead of throwing", async () => {
    const { store, data } = memoryHarness();
    data.set("breaker:p7", "{not json");
    expect((await breakerDecision("p7", { store })).state).toBe("closed");
    data.set("breaker:p8", JSON.stringify({ failures: "many", openedAt: "nope" }));
    expect((await breakerDecision("p8", { store })).state).toBe("closed");
  });

  it("lets the in-process store expire its own keys", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryBreakerStore;
      await recordBreakerFailure("p9", { store, failureThreshold: 1, openSeconds: 1 });
      expect((await breakerDecision("p9", { store })).state).toBe("open");
      vi.advanceTimersByTime(2_000);
      // Past the open window the next decision is a half-open probe; a success closes it.
      await expect(breakerDecision("p9", { store })).resolves.toMatchObject({ state: "half-open" });
      await expect(withCircuitBreaker("p9", async () => "ok", { store, openSeconds: 1 })).resolves.toBe("ok");
      expect((await breakerDecision("p9", { store })).state).toBe("closed");

      // The persisted key itself expires, so stale state cannot accumulate.
      await recordBreakerFailure("p9b", { store, failureThreshold: 1, openSeconds: 1 });
      expect((await breakerDecision("p9b", { store })).state).toBe("open");
      vi.advanceTimersByTime(700_000);
      await expect(breakerDecision("p9b", { store })).resolves.toMatchObject({ state: "closed", failures: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records success explicitly and clears failure counters", async () => {
    const { store } = memoryHarness();
    await recordBreakerFailure("p10", { store, failureThreshold: 5 });
    expect((await breakerDecision("p10", { store })).failures).toBe(1);
    await recordBreakerSuccess("p10", { store });
    expect(await breakerDecision("p10", { store })).toMatchObject({ failures: 0, state: "closed" });
  });

  it("preserves the original error when the breaker is closed", async () => {
    const { store } = memoryHarness();
    const original = new AppError(422, "VALIDATION_ERROR", "nope");
    await expect(
      withCircuitBreaker("p11", async () => {
        throw original;
      }, { store }),
    ).rejects.toBe(original);
  });
});
