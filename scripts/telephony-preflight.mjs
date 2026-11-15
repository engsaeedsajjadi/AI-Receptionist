/**
 * Offline and no-cost inbound PSTN readiness gate. No network, database or
 * secret-printing side effects. Presence and format alone never prove a call.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const E164 = /^\+[1-9]\d{6,14}$/;

export function evaluateTelephonyReadiness(env) {
  const checks = [];
  const check = (id, passed, hint) => checks.push({ id, passed: Boolean(passed), hint });
  const httpsUrl = (() => {
    try {
      const u = new URL(env.APP_URL ?? "");
      return u.protocol === "https:" && Boolean(u.hostname) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(u.hostname);
    } catch { return false; }
  })();
  const mediaUrl = (() => {
    try {
      const u = new URL(env.VOICE_MEDIA_PUBLIC_URL ?? "");
      return u.protocol === "wss:" && Boolean(u.hostname) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(u.hostname) && u.pathname === "/media";
    } catch { return false; }
  })();
  check("VOICE_PROVIDER", env.VOICE_PROVIDER === "twilio", "Set VOICE_PROVIDER=twilio");
  check("TWILIO_CREDENTIALS", Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN), "Configure Twilio credentials securely; never commit them");
  check("TWILIO_PHONE_NUMBER", E164.test(env.TWILIO_PHONE_NUMBER ?? ""), "Provision a Twilio number in E.164 format");
  check("APP_URL", httpsUrl, "Deploy an internet-accessible HTTPS application URL");
  check("VOICE_MEDIA_PUBLIC_URL", mediaUrl, "Expose the media sidecar as wss://public-host/media");
  check("VOICE_MEDIA_TOKEN", (env.VOICE_MEDIA_TOKEN ?? "").length >= 32, "Use a random media signing secret of at least 32 characters");
  check("VOICE_MEDIA_CODEC", (env.VOICE_MEDIA_CODEC ?? "mulaw") === "mulaw", "Twilio requires 8 kHz G.711 mu-law");
  check("VOICE_MEDIA_SAMPLE_RATE", Number(env.VOICE_MEDIA_SAMPLE_RATE ?? 8000) === 8000, "Set VOICE_MEDIA_SAMPLE_RATE=8000");
  check("STT_PROVIDER", Boolean(env.STT_PROVIDER && env.STT_PROVIDER !== "dev"), "Configure a real STT provider");
  check("TTS_PROVIDER", Boolean(env.TTS_PROVIDER && env.TTS_PROVIDER !== "dev"), "Configure a PCM-capable TTS provider");
  return { ready: checks.every(c => c.passed), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = evaluateTelephonyReadiness(process.env);
  console.log("=== PSTN INBOUND DEPLOYMENT PREFLIGHT (OFFLINE) ===");
  for (const c of result.checks) {
    console.log(`${c.id}=${c.passed ? "PASS" : "BLOCKED"}${c.passed ? "" : ` | ${c.hint}`}`);
  }
  console.log(`PSTN_READINESS=${result.ready ? "CONFIG_READY" : "BLOCKED"}`);
  console.log("LIVE_CALL_COMPLETED=NO");
  console.log("REAL_TWILIO_REQUESTS=0");
  console.log("DATABASE_MODIFIED=NO");
  if (!result.ready) process.exitCode = 2;
}
