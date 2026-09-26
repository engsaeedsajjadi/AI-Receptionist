import { checkDbHealth } from "@/db";
import { ok } from "@/lib/api";
import { describeProviderConfig } from "@/lib/env";
import { withApiHandling } from "@/lib/server-core";

export const dynamic = "force-dynamic";

/**
 * Liveness + basic info. Does NOT check downstream dependencies in depth
 * (use /api/health/ready for readiness).
 */
export async function GET() {
  return withApiHandling(async () => {
    const db = await checkDbHealth();
    return ok({
      ok: true,
      service: "ai-receptionist",
      version: process.env.npm_package_version ?? "0.2.0",
      uptimeSeconds: Math.round(process.uptime()),
      database: db.ok ? "up" : "down",
      providers: describeProviderConfig(),
      timestamp: new Date().toISOString(),
    });
  });
}
