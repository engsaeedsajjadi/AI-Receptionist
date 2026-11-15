import { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { AppError, ok } from "@/lib/api";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { verifyCheckout } from "@/lib/services/payments";

/**
 * Read the provider's truth for a checkout attempt. Never activates anything —
 * activation only happens from a verified provider webhook.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Tenant administrator required");
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) throw new AppError(400, "BAD_REQUEST", "Invalid checkout id");
    return ok(await verifyCheckout(auth.businessId, id));
  });
}
