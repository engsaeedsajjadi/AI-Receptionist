import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { runMaintenance } from "@/lib/services/maintenance";

const maintenanceSchema = z.object({
  transferStaleSeconds: z.number().int().min(60).max(86400).default(300),
  notificationStaleSeconds: z.number().int().min(60).max(86400).default(600),
});

/**
 * ADMIN-only manual trigger for the maintenance sweep (same work the cron
 * script performs). Body may be `{}` — thresholds carry safe defaults.
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(req, maintenanceSchema);
    const result = await runMaintenance({ ...body, requestId: rid });
    return ok(result);
  });
}
