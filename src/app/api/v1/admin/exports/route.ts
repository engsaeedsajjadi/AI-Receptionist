import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { ExportRequestSchema, listDataExports, processDataExport, requestDataExport } from "@/lib/services/data-governance";

/** Tenant data export (assembled by the worker; download URLs expire). */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    return ok({ exports: await listDataExports(auth.businessId) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(req, ExportRequestSchema);
    const row = await requestDataExport({ userId: auth.userId, businessId: auth.businessId }, body);
    // Produce immediately when the caller asks synchronously; the worker is the
    // safety net for anything that fails here (status stays PENDING).
    try {
      await processDataExport(row.id);
    } catch {
      // The row is FAILED/PENDING and visible to the tenant; no silent success.
    }
    return ok(await listDataExports(auth.businessId), 201);
  });
}
