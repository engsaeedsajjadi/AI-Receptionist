import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, AppError } from "@/lib/api";
import { hasRole } from "@/lib/permissions";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
import { getQuotaStatus } from "@/lib/services/quotas";
export async function GET(req: NextRequest) { return withApiHandling(async () => {
  await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
  if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Tenant administrator required");
  return ok(await getQuotaStatus(auth.businessId));
}); }
