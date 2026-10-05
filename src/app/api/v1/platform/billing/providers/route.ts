import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { listPaymentProviders, reconcileBillingLifecycle } from "@/lib/services/payments";
import { paymentProviderStatus } from "@/lib/providers/payments";
import { requirePlatformAdmin } from "@/lib/services/platform";
import { db } from "@/db";

/** Provider capabilities (honest, never optimistic) + configured provider rows. */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok({ status: paymentProviderStatus(), providers: await listPaymentProviders(auth.userId) });
  });
}

/** Run the idempotent lifecycle sweep (expire attempts, flag past-due). */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    await requirePlatformAdmin(db, auth.userId);
    return ok(await reconcileBillingLifecycle());
  });
}
