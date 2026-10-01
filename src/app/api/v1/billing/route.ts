import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { getBillingOverview } from "@/lib/services/billing";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const billing = await getBillingOverview(auth.businessId);
    return ok(billing ?? { subscription: null, usage: [], invoices: [] });
  });
}
