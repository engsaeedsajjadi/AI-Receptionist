import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { RefundRequestSchema, refundPayment } from "@/lib/services/payments";

/** Platform-only refund of a captured charge (immutable ledger, audit-logged). */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await refundPayment(auth.userId, await parseJsonWith(req, RefundRequestSchema)), 201);
  });
}
