import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { assignUserRole, UserRoleAssignSchema } from "@/lib/services/access";

/** Assign or revoke a custom role for a user in this tenant. */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(req, UserRoleAssignSchema);
    return ok(await assignUserRole({ userId: auth.userId, businessId: auth.businessId, platform: auth.role === "SUPER_ADMIN" }, body));
  });
}
