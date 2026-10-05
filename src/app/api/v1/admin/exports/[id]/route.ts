import { NextRequest } from "next/server";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { dataExportDownload } from "@/lib/services/data-governance";

/** Time-limited, tenant-scoped download URL for a ready export. */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await context.params;
    return ok(await dataExportDownload(auth.businessId, id));
  });
}
