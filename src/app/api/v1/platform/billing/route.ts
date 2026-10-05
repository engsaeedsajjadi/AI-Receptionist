import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
import { listPlatformInvoices, recordInvoicePayment, PaymentSchema } from "@/lib/services/billing";
export async function GET(req: NextRequest) { return withApiHandling(async () => {
  await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
  return ok({ invoices: await listPlatformInvoices(auth.userId) });
}); }
export async function POST(req: NextRequest) { return withApiHandling(async () => {
  await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
  return ok(await recordInvoicePayment(auth.userId, await parseJsonWith(req, PaymentSchema)));
}); }
