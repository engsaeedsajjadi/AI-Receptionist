import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

/**
 * Error reporting must never leak credentials and must never break the request
 * path. Both directions are asserted here: the init options and `beforeSend`
 * redaction, and the "monitoring is misconfigured/unavailable" paths that have
 * to degrade silently instead of throwing into a request.
 */

type SentryMock = {
  init: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  setTag: ReturnType<typeof vi.fn>;
  setUser: ReturnType<typeof vi.fn>;
};

async function loadMonitoring(options: { dsn?: string; initThrows?: boolean } = {}) {
  vi.resetModules();
  const sentry: SentryMock = {
    init: vi.fn(() => {
      if (options.initThrows) throw new Error("sentry init failed");
    }),
    captureException: vi.fn(),
    setTag: vi.fn(),
    setUser: vi.fn(),
  };
  vi.doMock("@sentry/nextjs", () => ({ ...sentry, default: sentry }));
  if (options.dsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = options.dsn;
  resetEnvCache();
  const monitoring = await import("@/lib/monitoring");
  return { monitoring, sentry };
}

afterEach(() => {
  delete process.env.SENTRY_DSN;
  resetEnvCache();
  vi.doUnmock("@sentry/nextjs");
});

describe("monitoring (Sentry) integration", () => {
  it("stays disabled without a DSN and never imports the SDK", async () => {
    const { monitoring, sentry } = await loadMonitoring({ dsn: "" });
    await monitoring.initMonitoring();
    expect(sentry.init).not.toHaveBeenCalled();
    expect(monitoring.isMonitoringEnabled()).toBe(false);
    // Disabled monitoring is a no-op, not a crash.
    expect(() => monitoring.captureServerError(new Error("boom"), { password: "x" })).not.toThrow();
    expect(() => monitoring.setRequestContext({ requestId: "r1" })).not.toThrow();
  });

  it("initializes once, with header redaction in beforeSend", async () => {
    const { monitoring, sentry } = await loadMonitoring({ dsn: "https://key@sentry.example/1" });
    await monitoring.initMonitoring();
    await monitoring.initMonitoring(); // idempotent
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(monitoring.isMonitoringEnabled()).toBe(true);

    const initOptions = sentry.init.mock.calls[0][0] as {
      dsn: string;
      beforeSend: (event: { request?: { headers?: Record<string, unknown> } }) => unknown;
    };
    expect(initOptions.dsn).toBe("https://key@sentry.example/1");
    const event = {
      request: {
        headers: {
          authorization: "Bearer secret",
          Cookie: "session=1",
          "x-api-key": "abc",
          "x-tenant-token": "t",
          "content-type": "application/json",
        },
      },
    };
    const sanitized = initOptions.beforeSend(event) as { request: { headers: Record<string, unknown> } };
    expect(sanitized.request.headers.authorization).toBe("[REDACTED]");
    expect(sanitized.request.headers.Cookie).toBe("[REDACTED]");
    expect(sanitized.request.headers["x-api-key"]).toBe("[REDACTED]");
    expect(sanitized.request.headers["x-tenant-token"]).toBe("[REDACTED]");
    expect(sanitized.request.headers["content-type"]).toBe("application/json");
  });

  it("redacts captured context and tags the request scope", async () => {
    const { monitoring, sentry } = await loadMonitoring({ dsn: "https://key@sentry.example/1" });
    await monitoring.initMonitoring();

    monitoring.captureServerError(new Error("provider failed"), {
      businessId: "b1",
      authorization: "Bearer secret",
      apiKey: "sk-live-123",
      nested: { password: "hunter2", note: "kept" },
    });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const extra = sentry.captureException.mock.calls[0][1].extra as Record<string, unknown>;
    expect(JSON.stringify(extra)).not.toContain("Bearer secret");
    expect(JSON.stringify(extra)).not.toContain("sk-live-123");
    expect(JSON.stringify(extra)).not.toContain("hunter2");
    expect(extra.businessId).toBe("b1");

    monitoring.setRequestContext({ requestId: "req-1", businessId: "b1", userId: "u1", callId: "c1" });
    expect(sentry.setTag).toHaveBeenCalledWith("request_id", "req-1");
    expect(sentry.setTag).toHaveBeenCalledWith("business_id", "b1");
    expect(sentry.setTag).toHaveBeenCalledWith("call_id", "c1");
    expect(sentry.setUser).toHaveBeenCalledWith({ id: "u1" });

    // No request id yet (e.g. startup code): still a usable tag, never a crash.
    monitoring.setRequestContext({});
    expect(sentry.setTag).toHaveBeenCalledWith("request_id", "unknown");
  });

  it("degrades to disabled when the SDK cannot initialize", async () => {
    const { monitoring, sentry } = await loadMonitoring({ dsn: "https://key@sentry.example/1", initThrows: true });
    await monitoring.initMonitoring();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(monitoring.isMonitoringEnabled()).toBe(false);
    // A broken SDK must not turn a handled error into a crash.
    expect(() => monitoring.captureServerError(new Error("boom"))).not.toThrow();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("survives an environment that throws while reading configuration", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", async () => {
      const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
      return { ...actual, getEnv: () => { throw new Error("env exploded"); } };
    });
    const monitoring = await import("@/lib/monitoring");
    await expect(monitoring.initMonitoring()).resolves.toBeUndefined();
    expect(monitoring.isMonitoringEnabled()).toBe(false);
    vi.doUnmock("@/lib/env");
    vi.resetModules();
  });
});
