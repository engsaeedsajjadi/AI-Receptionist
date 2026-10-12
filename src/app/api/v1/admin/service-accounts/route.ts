import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { createServiceAccount, listServiceAccounts, ServiceAccountCreateSchema } from "@/lib/services/access";

/** Machine identities for a tenant (credential returned once). */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    return ok({ accounts: await listServiceAccounts(auth.businessId) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(req, ServiceAccountCreateSchema);
    return ok(await createServiceAccount({ userId: auth.userId, businessId: auth.businessId, platform: auth.role === "SUPER_ADMIN" }, body), 201);
  });
}
