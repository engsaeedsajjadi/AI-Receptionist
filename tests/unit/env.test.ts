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

/**
 * Every production guard is asserted individually: a partially configured
 * production environment must fail fast with a message naming the exact missing
 * secret, never start with a dev provider or an anonymous webhook endpoint.
 */
describe("production provider guards", () => {
  const productionBase = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://prod/db",
    REDIS_URL: "redis://prod:6379",
    JWT_SECRET: "a".repeat(40),
    JWT_REFRESH_SECRET: "b".repeat(40),
    VOICE_WEBHOOK_SECRET: "voice-secret",
    N8N_WEBHOOK_SECRET: "n8n-secret",
    N8N_ENABLED: "false",
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-live",
    STT_PROVIDER: "openai",
    TTS_PROVIDER: "openai",
    EMBEDDING_PROVIDER: "openai",
    VOICE_PROVIDER: "dev",
    // Auto-answer is off by default: the media guards are asserted explicitly below.
    VOICE_AUTO_ANSWER: "false",
    PAYMENT_PROVIDER: "disabled",
  } as const;

  async function expectProdFailure(overrides: Record<string, string>, pattern: RegExp) {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...productionBase, ...overrides };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    expect(() => getEnv()).toThrow(pattern);
  }

  it("accepts a fully configured production environment", async () => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...productionBase, VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", VOICE_AUTO_ANSWER: "false" };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    expect(getEnv().VOICE_PROVIDER).toBe("twilio");
  });

  it("refuses each missing secret and unsafe provider combination", async () => {
    await expectProdFailure({ N8N_ENABLED: "true", N8N_API_KEY: "" }, /N8N_API_KEY/);
    await expectProdFailure({ STT_PROVIDER: "dev" }, /STT_PROVIDER=dev/);
    await expectProdFailure({ TTS_PROVIDER: "dev" }, /TTS_PROVIDER=dev/);
    await expectProdFailure({ EMBEDDING_PROVIDER: "dev" }, /EMBEDDING_PROVIDER=dev/);
    await expectProdFailure({ VOICE_PROVIDER: "dev" }, /VOICE_PROVIDER=dev/);
    await expectProdFailure({ LLM_PROVIDER: "compatible", COMPATIBLE_LLM_BASE_URL: "" }, /COMPATIBLE_LLM_BASE_URL/);
    await expectProdFailure({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "" }, /OPENAI_API_KEY/);
    await expectProdFailure({ VOICE_PROVIDER: "generic", VOICE_API_BASE_URL: "", VOICE_API_KEY: "" }, /VOICE_API_BASE_URL/);
    await expectProdFailure({ VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "" }, /TWILIO_ACCOUNT_SID/);
    await expectProdFailure({ VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", PAYMENT_PROVIDER: "test" }, /PAYMENT_PROVIDER=test/);
    await expectProdFailure(
      { VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", PAYMENT_PROVIDER: "stripe", PAYMENT_API_BASE_URL: "https://pay.example.com", PAYMENT_API_KEY: "pk", PAYMENT_WEBHOOK_SECRET: "", PAYMENT_MODE: "live" },
      /PAYMENT_WEBHOOK_SECRET/,
    );
    await expectProdFailure(
      { VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", PAYMENT_PROVIDER: "stripe", PAYMENT_API_BASE_URL: "https://pay.example.com", PAYMENT_API_KEY: "pk", PAYMENT_WEBHOOK_SECRET: "whsec", PAYMENT_MODE: "test" },
      /PAYMENT_MODE/,
    );
  });

  it("requires media and payment credentials only when the feature is on", async () => {
    await expectProdFailure(
      { VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", VOICE_AUTO_ANSWER: "true", VOICE_MEDIA_PUBLIC_URL: "", VOICE_MEDIA_TOKEN: "" },
      /VOICE_MEDIA_PUBLIC_URL/,
    );
    await expectProdFailure(
      { VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", VOICE_AUTO_ANSWER: "true", VOICE_MEDIA_PUBLIC_URL: "wss://media.example.com", VOICE_MEDIA_TOKEN: "" },
      /VOICE_MEDIA_TOKEN/,
    );
    await expectProdFailure(
      { VOICE_PROVIDER: "generic", VOICE_API_BASE_URL: "https://voice.example.com", VOICE_API_KEY: "k", VOICE_AUTO_ANSWER: "true", VOICE_MEDIA_PUBLIC_URL: "wss://media.example.com", VOICE_MEDIA_TOKEN: "" },
      /VOICE_MEDIA_TOKEN/,
    );
    await expectProdFailure(
      { VOICE_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", PAYMENT_PROVIDER: "stripe", PAYMENT_API_BASE_URL: "", PAYMENT_API_KEY: "" },
      /PAYMENT_API_BASE_URL/,
    );
  });

  it("rejects malformed values with a single readable message", async () => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...productionBase, JWT_ACCESS_EXPIRE_MINUTES: "0" };
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    expect(() => getEnv()).toThrow(/Invalid environment configuration/);
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...productionBase, IDENTITY_ENCRYPTION_KEY: "not-hex" };
    const reloaded = await import("@/lib/env");
    reloaded.resetEnvCache();
    expect(() => reloaded.getEnv()).toThrow(/Invalid environment configuration/);
  });

  it("reports the runtime mode helpers for each environment", async () => {
    for (const [nodeEnv, expected] of [
      ["production", { isProduction: true, isTest: false, isDev: false }],
      ["test", { isProduction: false, isTest: true, isDev: false }],
      ["development", { isProduction: false, isTest: false, isDev: true }],
    ] as const) {
      vi.resetModules();
      process.env = { ...ORIGINAL_ENV, ...productionBase, NODE_ENV: nodeEnv };
      const mod = await import("@/lib/env");
      expect({ isProduction: mod.isProduction, isTest: mod.isTest, isDev: mod.isDev }).toEqual(expected);
    }
  });
});
