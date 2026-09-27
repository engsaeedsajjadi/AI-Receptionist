import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("env validation", () => {
  it("requires DATABASE_URL", async () => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "test", DATABASE_URL: "" };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it("loads defaults in test env", async () => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "test", DATABASE_URL: "postgresql://test" };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    const env = getEnv();
    expect(env.DATABASE_URL).toBe("postgresql://test");
    expect(env.LLM_PROVIDER).toBe("dev");
  });

  it("fails fast in production without critical secrets", async () => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://prod/db",
      REDIS_URL: "",
      JWT_SECRET: "short",
    };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    expect(() => getEnv()).toThrow(/REDIS_URL|JWT_SECRET/);
  });

  it("forbids dev providers in production", async () => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://prod/db",
      REDIS_URL: "redis://prod:6379",
      JWT_SECRET: "a".repeat(40),
      JWT_REFRESH_SECRET: "b".repeat(40),
      VOICE_WEBHOOK_SECRET: "voice-secret",
      N8N_WEBHOOK_SECRET: "n8n-secret",
      LLM_PROVIDER: "dev",
    };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    expect(() => getEnv()).toThrow(/LLM_PROVIDER=dev/);
  });
});
