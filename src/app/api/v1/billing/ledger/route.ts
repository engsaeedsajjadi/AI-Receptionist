import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { AppError, ok } from "@/lib/api";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { billingLedger } from "@/lib/services/payments";
import { paymentProviderStatus } from "@/lib/providers/payments";

/** Tenant billing ledger: subscription status, charges, refunds and credit notes. */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Tenant administrator required");
    const ledger = await billingLedger(auth.businessId);
    return ok({ ...ledger, provider: paymentProviderStatus() });
  });
}
