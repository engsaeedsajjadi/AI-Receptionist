import { NextRequest } from "next/server";
import { checkDbHealth } from "@/db";
import { ok } from "@/lib/api";
import { getEnv, isProduction } from "@/lib/env";
import { checkRedisHealth } from "@/lib/redis";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { resolveMediaBootstrapConfig, validateMediaBootstrapConfig } from "@/lib/voice/media-bootstrap";

export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean; latencyMs?: number; error?: string; configured?: boolean };

/**
 * Readiness: verifies required dependencies.
 * - PostgreSQL must be reachable
 * - Redis must be reachable when configured/required (production)
 * - Critical provider configuration must be present (configured ≠ healthy,
 *   so provider checks only report configuration status, not live API calls)
 */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    // Readiness is scraped per-IP; orchestrator probes use /live (never
    // limited) so throttling here cannot cause restarts.
    await checkGlobalPublicRateLimit(req);
    const checks: Check[] = [];

    const db = await checkDbHealth();
    checks.push({ name: "postgres", ok: db.ok, latencyMs: db.latencyMs, error: db.error });

    let envOk = true;
    let providerInfo: Record<string, string> = {};
    try {
      const e = getEnv();
      providerInfo = {
        llm: e.LLM_PROVIDER,
        embedding: e.EMBEDDING_PROVIDER,
        stt: e.STT_PROVIDER,
        tts: e.TTS_PROVIDER,
        voice: e.VOICE_PROVIDER,
        storage: e.STORAGE_PROVIDER,
      };
      const needsOpenAI =
        e.LLM_PROVIDER === "openai" ||
        e.STT_PROVIDER === "openai" ||
        e.TTS_PROVIDER === "openai" ||
        e.EMBEDDING_PROVIDER === "openai";
      const openAiOk = !needsOpenAI || Boolean(e.OPENAI_API_KEY);
      const voiceOk = e.VOICE_PROVIDER !== "generic" || Boolean(e.VOICE_API_BASE_URL && e.VOICE_API_KEY);
      checks.push({ name: "provider-config:openai", ok: openAiOk, configured: openAiOk });
      checks.push({ name: "provider-config:voice", ok: voiceOk, configured: voiceOk });
      // Voice-media bootstrap prerequisites (§3 production detectability):
      // REPORTED, never fatal. Webhook-topology deployments legitimately run
      // without sidecar streaming, and per-business autoAnswer overrides mean
      // global state alone cannot decide. Enforcement happens per call inside
      // bootstrapMedia, fail-closed before answerCall.
      const mediaValid = validateMediaBootstrapConfig(resolveMediaBootstrapConfig());
      checks.push({ name: "provider-config:voice-media", ok: true, configured: mediaValid.ok });
      envOk = openAiOk && voiceOk;
    } catch (err) {
      envOk = false;
      checks.push({
        name: "env",
        ok: false,
        error: err instanceof Error ? err.message : "invalid_env",
      });
    }

    const redisRequired = isProduction;
    const redis = await checkRedisHealth();
    if (redisRequired || redis.ok) {
      checks.push({
        name: "redis",
        ok: redis.ok,
        latencyMs: redis.latencyMs,
        error: redis.error,
        configured: redis.error !== "not_configured",
      });
    } else {
      checks.push({ name: "redis", ok: true, configured: false, error: "not_configured_dev_only" });
    }

    const ready = checks.every((c) => c.ok) && envOk;
    return ok(
      {
        status: ready ? "ready" : "not_ready",
        checks,
        providers: providerInfo,
        timestamp: new Date().toISOString(),
      },
      ready ? 200 : 503,
    );
  });
}
