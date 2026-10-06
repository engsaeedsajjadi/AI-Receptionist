import { NextRequest } from "next/server";
import { checkDbHealth, checkMigrationsHealth } from "@/db";
import { ok } from "@/lib/api";
import { getEnv, isProduction } from "@/lib/env";
import { checkRedisHealth } from "@/lib/redis";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean; latencyMs?: number; error?: string; configured?: boolean };

/**
 * Storage readiness: the resolved provider must be constructible and, for the
 * local provider, its directory must exist and be writable (a live S3 probe is
 * deliberately not part of readiness — the operator reaches it via /ready
 * only after configuration, and object-store latency must not restart pods).
 */
async function checkStorageHealth(): Promise<{ ok: boolean; configured: boolean; error?: string }> {
  try {
    const { getStorageProvider } = await import("@/lib/providers/storage");
    const provider = getStorageProvider();
    if (provider.name === "local") {
      const { access, mkdir } = await import("node:fs/promises");
      const dir = getEnv().LOCAL_STORAGE_DIR;
      await mkdir(dir, { recursive: true });
      await access(dir);
    }
    return { ok: true, configured: true };
  } catch (err) {
    return { ok: false, configured: false, error: err instanceof Error ? err.message : "storage_unavailable" };
  }
}

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

    // Schema compatibility: the app refuses to report ready when the database
    // has not had every migration this build expects applied.
    const migrations = await checkMigrationsHealth();
    checks.push({
      name: "migrations",
      ok: migrations.ok,
      error: migrations.ok ? undefined : `applied ${migrations.applied}/${migrations.expected}${migrations.error ? ` (${migrations.error})` : ""}`,
    });

    const storage = await checkStorageHealth();
    checks.push({ name: "storage", ok: storage.ok, error: storage.error, configured: storage.configured });

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
