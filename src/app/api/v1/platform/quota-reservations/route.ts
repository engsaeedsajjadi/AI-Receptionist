import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
import { listQuotaReservations, reconcileQuotaReservation, ReconcileQuotaSchema } from "@/lib/services/quotas";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await listQuotaReservations(auth.userId, Object.fromEntries(req.nextUrl.searchParams)));
  });
}
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await reconcileQuotaReservation(auth.userId, await parseJsonWith(req, ReconcileQuotaSchema)));
  });
}
