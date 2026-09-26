import { describe, expect, it } from "vitest";
import { logError, logInfo, logWarn, redactForLog } from "@/lib/logger";

const SECRET = "super-secret-value-12345";

describe("redactForLog", () => {
  it("redacts every secret-bearing config key", () => {
    const input: Record<string, unknown> = {
      authorization: SECRET,
      cookie: SECRET,
      password: SECRET,
      passwordHash: SECRET,
      secret: SECRET,
      token: SECRET,
      refreshToken: SECRET,
      accessToken: SECRET,
      DATABASE_URL: SECRET,
      REDIS_URL: SECRET,
      JWT_SECRET: SECRET,
      JWT_REFRESH_SECRET: SECRET,
      OPENAI_API_KEY: SECRET,
      COMPATIBLE_LLM_API_KEY: SECRET,
      VOICE_API_KEY: SECRET,
      VOICE_WEBHOOK_SECRET: SECRET,
      VOICE_MEDIA_TOKEN: SECRET,
      N8N_API_KEY: SECRET,
      N8N_WEBHOOK_SECRET: SECRET,
      N8N_BASIC_AUTH_PASSWORD: SECRET,
      SMTP_PASS: SECRET,
      SMTP_USER: SECRET,
      S3_SECRET_ACCESS_KEY: SECRET,
      S3_ACCESS_KEY_ID: SECRET,
      TELEGRAM_BOT_TOKEN: SECRET,
    };
    const out = redactForLog(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key], key).toBe("[REDACTED]");
    }
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("matches secret keys case-insensitively", () => {
    const out = redactForLog({
      Authorization: SECRET,
      API_KEY: SECRET,
      Password: SECRET,
      Token: SECRET,
      Cookie: SECRET,
    }) as Record<string, unknown>;
    expect(Object.values(out).every((v) => v === "[REDACTED]")).toBe(true);
  });

  it("redacts nested objects and arrays, preserves innocent siblings", () => {
    const out = redactForLog({
      requestId: "req-1",
      businessId: "biz-1",
      headers: { authorization: SECRET, "x-idempotency-key": "key-9" },
      items: [{ token: SECRET }, { name: "plain" }],
    }) as Record<string, unknown>;
    expect(out.requestId).toBe("req-1");
    expect(out.businessId).toBe("biz-1");
    expect((out.headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((out.headers as Record<string, unknown>)["x-idempotency-key"]).toBe("key-9");
    expect((out.items as Array<Record<string, unknown>>)[0].token).toBe("[REDACTED]");
    expect((out.items as Array<Record<string, unknown>>)[1].name).toBe("plain");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("redacts bearer tokens embedded in free-text messages", () => {
    expect(redactForLog(`upstream call failed, auth Bearer ${SECRET} rejected`)).toBe(
      "upstream call failed, auth Bearer [REDACTED] rejected",
    );
    expect(redactForLog("no secrets here")).toBe("no secrets here");
  });

  it("passes non-secret scalars through untouched", () => {
    expect(redactForLog(42)).toBe(42);
    expect(redactForLog(true)).toBe(true);
    expect(redactForLog(null)).toBeNull();
    expect(redactForLog(undefined)).toBeUndefined();
  });
});

describe("log pipeline (real pino output)", () => {
  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const patched = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = patched;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  }

  it("logInfo/logWarn/logError never emit secrets", () => {
    const output = captureStdout(() => {
      logInfo("info path", { authorization: SECRET, operation: "test.redact" });
      logWarn("warn path", { password: SECRET, operation: "test.redact" });
      logError("error path", { token: SECRET, operation: "test.redact", error: new Error("boom") });
    });
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(SECRET);
    // Structure survives: messages + non-secret context are logged.
    expect(output).toContain("info path");
    expect(output).toContain("test.redact");
  });
});
