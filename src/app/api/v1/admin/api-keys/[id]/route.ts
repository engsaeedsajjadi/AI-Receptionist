import { NextRequest } from "next/server";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { revokeApiKey } from "@/lib/services/access";

/** Revoke an API key (soft revoke; the hash is retained for audit). */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await context.params;
    return ok(await revokeApiKey({ userId: auth.userId, businessId: auth.businessId }, id));
  });
}
