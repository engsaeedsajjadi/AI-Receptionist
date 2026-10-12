import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { AppError, ok, parseJsonWith } from "@/lib/api";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { CheckoutRequestSchema, startCheckout } from "@/lib/services/payments";

/** Start a provider checkout for a paid plan (tenant administrator only). */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Tenant administrator required");
    const attempt = await startCheckout(auth.businessId, await parseJsonWith(req, CheckoutRequestSchema));
    return ok(attempt, 201);
  });
}
