import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { BrandingPatchSchema, getTenantBranding, updateTenantBranding } from "@/lib/services/branding";

/**
 * Tenant white-labeling settings.
 *
 * GET is readable by any member (the dashboard shell needs it to render), PATCH
 * requires ADMIN and the `whiteLabel` entitlement — enforced in the service, so
 * the guarantee holds for any caller, not just this route.
 */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await getTenantBranding(auth.businessId));
  });
}

export async function PATCH(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    const patch = await parseJsonWith(req, BrandingPatchSchema);
    return ok(await updateTenantBranding({ businessId: auth.businessId, userId: auth.userId, patch }));
  });
}
