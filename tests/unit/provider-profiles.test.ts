import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The AI stack is chosen by deployment configuration. `deploy/profiles/*.env.example`
 * are the supported choices; each must boot a PRODUCTION server once its blanks
 * are filled, and switching profile must switch every provider together.
 */
const PROFILE_DIR = path.join(process.cwd(), "deploy", "profiles");

function parseProfile(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path.join(PROFILE_DIR, name), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Everything a production server needs that is NOT part of an AI profile. Generated, never committed. */
function productionBase(): Record<string, string> {
  const secret = () => randomBytes(32).toString("hex");
  return {
    NODE_ENV: "production",
    APP_URL: "https://receptionist.example.test",
    DATABASE_URL: "postgresql://app@db.internal:5432/app",
    REDIS_URL: "redis://redis.internal:6379",
    JWT_SECRET: secret(), JWT_REFRESH_SECRET: secret(), VOICE_WEBHOOK_SECRET: secret(),
    N8N_WEBHOOK_SECRET: secret(), IDENTITY_ENCRYPTION_KEY: secret(), VOICE_MEDIA_TOKEN: secret(),
    N8N_ENABLED: "false", VOICE_PROVIDER: "disabled", PAYMENT_PROVIDER: "disabled",
  };
}

/**
 * `isProduction` is fixed when the env module is first evaluated, so the module
 * is re-imported under NODE_ENV=production; otherwise every production rule
 * would be skipped and these tests would pass without checking anything.
 */
async function boot(profile: Record<string, string>, fill: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...productionBase(), ...profile, ...fill })) vi.stubEnv(k, v);
  vi.resetModules();
  const env = await import("@/lib/env");
  expect(env.isProduction).toBe(true);
  return env.getEnv();
}

/** An operator filling the blanks of a profile. */
const FILLED = {
  COMPATIBLE_LLM_API_KEY: "placeholder-not-a-real-key", COMPATIBLE_LLM_MODEL: "chat-model",
  STT_MODEL: "stt-model", TTS_MODEL: "tts-model", TTS_VOICE: "voice-1", TTS_ALLOWED_VOICE_IDS: "voice-1",
  EMBEDDING_MODEL: "embedding-model",
};

describe("AI provider profiles", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("ships exactly the documented profiles, and none contains a filled-in credential", () => {
    const files = readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".env.example")).sort();
    expect(files).toEqual(["gemini-cloud.env.example", "local-models.env.example"]);
    expect(parseProfile("gemini-cloud.env.example").COMPATIBLE_LLM_API_KEY).toBe("");
    expect(parseProfile("local-models.env.example").COMPATIBLE_LLM_API_KEY).toBe("local");
  });

  it("gemini-cloud boots a production server on Google's endpoint once the blanks are filled", async () => {
    const e = await boot(parseProfile("gemini-cloud.env.example"), FILLED);
    expect([e.LLM_PROVIDER, e.STT_PROVIDER, e.TTS_PROVIDER, e.EMBEDDING_PROVIDER])
      .toEqual(["compatible", "gemini", "gemini", "compatible"]);
    expect(new URL(e.COMPATIBLE_LLM_BASE_URL).hostname).toBe("generativelanguage.googleapis.com");
    expect(e.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(e.VOICE_CLONING_ENABLED).toBe(false);
  });

  it("local-models boots a production server that talks to no Google host", async () => {
    const profile = parseProfile("local-models.env.example");
    const e = await boot(profile, { COMPATIBLE_LLM_MODEL: "chat-model", STT_MODEL: "stt-model", EMBEDDING_MODEL: "embedding-model" });
    expect([e.LLM_PROVIDER, e.STT_PROVIDER, e.TTS_PROVIDER, e.EMBEDDING_PROVIDER])
      .toEqual(["compatible", "compatible", "piper", "compatible"]);
    expect(Object.values(profile).join(" ")).not.toMatch(/google|openai\.com/i);
    expect(e.EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it("refuses to boot with a profile whose credentials were left blank", async () => {
    await expect(boot(parseProfile("gemini-cloud.env.example"))).rejects.toThrow(/COMPATIBLE_LLM_API_KEY is required/);
    const local = parseProfile("local-models.env.example");
    await expect(boot({ ...local, COMPATIBLE_LLM_BASE_URL: "" })).rejects.toThrow(/COMPATIBLE_LLM_BASE_URL is required/);
  });

  it("never lets a development provider into production, whatever the profile", async () => {
    const profile = { ...parseProfile("gemini-cloud.env.example"), ...FILLED };
    for (const key of ["LLM_PROVIDER", "STT_PROVIDER", "TTS_PROVIDER", "EMBEDDING_PROVIDER"]) {
      await expect(boot({ ...profile, [key]: "dev" }), key).rejects.toThrow(/not allowed in production/);
    }
  });
});
