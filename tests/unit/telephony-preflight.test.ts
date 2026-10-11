import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/telephony-preflight.mjs";
const baseline = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };

function run(extra: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: { ...baseline, ...extra },
    timeout: 5000,
  });
}

describe("PSTN readiness (offline and credential-safe)", () => {
  it("blocks local development without making calls or leaking credentials", () => {
    const result = run({ APP_URL: "http://localhost:3100", VOICE_PROVIDER: "dev" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("PSTN_READINESS=BLOCKED");
    expect(result.stdout).toContain("LIVE_CALL_COMPLETED=NO");
    expect(result.stdout).toContain("REAL_TWILIO_REQUESTS=0");
  });
  it("accepts plausibly configured staging but never claims a live call", () => {
    const token = "sample-media-secret-for-offline-tests-only";
    const result = run({
      VOICE_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "example-account",
      TWILIO_AUTH_TOKEN: "example-token",
      TWILIO_PHONE_NUMBER: "+12125550123",
      APP_URL: "https://app.example.test",
      VOICE_MEDIA_PUBLIC_URL: "wss://media.example.test/media",
      VOICE_MEDIA_TOKEN: token,
      VOICE_MEDIA_CODEC: "mulaw",
      VOICE_MEDIA_SAMPLE_RATE: "8000",
      STT_PROVIDER: "gemini",
      TTS_PROVIDER: "gemini",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PSTN_READINESS=CONFIG_READY");
    expect(result.stdout).toContain("LIVE_CALL_COMPLETED=NO");
    expect(result.stdout).not.toContain(token);
  });
  it("rejects an insecure WS URL and invalid E.164 number", () => {
    const result = run({
      VOICE_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "example-account",
      TWILIO_AUTH_TOKEN: "example-token",
      TWILIO_PHONE_NUMBER: "09123456789",
      APP_URL: "https://app.example.test",
      VOICE_MEDIA_PUBLIC_URL: "ws://localhost:3001/media",
      VOICE_MEDIA_TOKEN: "sample-media-secret-for-offline-tests-only",
      STT_PROVIDER: "gemini",
      TTS_PROVIDER: "gemini",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("TWILIO_PHONE_NUMBER=BLOCKED");
    expect(result.stdout).toContain("VOICE_MEDIA_PUBLIC_URL=BLOCKED");
  });
});
