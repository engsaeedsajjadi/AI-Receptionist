import { describe, expect, it } from "vitest";
import { runtimeReadiness } from "@/lib/release-readiness";

describe("runtime release readiness", () => {
  it("fails closed with development providers", () => {
    const result = runtimeReadiness({
      NODE_ENV: "development",
      LLM_PROVIDER: "dev",
      EMBEDDING_PROVIDER: "dev",
      STT_PROVIDER: "dev",
      TTS_PROVIDER: "dev",
      VOICE_PROVIDER: "dev",
      STORAGE_PROVIDER: "local",
    });
    expect(result.coreReady).toBe(false);
    expect(result.providers.llm.configured).toBe(false);
    expect(result.providers.storage.configured).toBe(true);
    expect(result.capabilities.transactionalOutbox).toBe(true);
  });

  it("reports a fully configured core voice path without returning secrets", () => {
    const result = runtimeReadiness({
      NODE_ENV: "production",
      LLM_PROVIDER: "openai",
      EMBEDDING_PROVIDER: "openai",
      STT_PROVIDER: "openai",
      TTS_PROVIDER: "openai",
      OPENAI_API_KEY: "secret",
      VOICE_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "secret-token",
      VOICE_MEDIA_PUBLIC_URL: "wss://media.staging.example.com/media",
      VOICE_MEDIA_TOKEN: "media-secret",
      STORAGE_PROVIDER: "s3",
      S3_ENDPOINT: "https://s3.staging.example.com",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(result.coreReady).toBe(true);
    expect(result.providers.telephony.configured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("media-secret");
  });

  it("does not make optional payment or telemetry a voice go-live blocker", () => {
    const result = runtimeReadiness({
      LLM_PROVIDER: "compatible",
      EMBEDDING_PROVIDER: "compatible",
      STT_PROVIDER: "compatible",
      TTS_PROVIDER: "compatible",
      COMPATIBLE_LLM_BASE_URL: "https://ai.example.test/v1",
      VOICE_PROVIDER: "generic",
      VOICE_API_BASE_URL: "https://voice.example.test",
      VOICE_API_KEY: "x",
      VOICE_AUTO_ANSWER: "false",
      STORAGE_PROVIDER: "local",
      PAYMENT_PROVIDER: "disabled",
    });
    expect(result.coreReady).toBe(true);
    expect(result.providers.payment.configured).toBe(false);
    expect(result.providers.telemetry.configured).toBe(false);
  });
});
