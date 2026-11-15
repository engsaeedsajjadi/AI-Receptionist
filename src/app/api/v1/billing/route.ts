import { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { AppError, ok, parseJsonWith } from "@/lib/api";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { getBilling, requestInvoice, cancelInvoice, setSubscriptionCancellation, InvoiceRequestSchema } from "@/lib/services/billing";
async function authorize(req: NextRequest) {
  await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
  if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Tenant administrator required");
  return auth;
}
export async function GET(req: NextRequest) { return withApiHandling(async () => ok(await getBilling((await authorize(req)).businessId))); }
export async function POST(req: NextRequest) { return withApiHandling(async () => {
  const auth = await authorize(req); return ok(await requestInvoice(auth.businessId, await parseJsonWith(req, InvoiceRequestSchema)), 201);
}); }
export async function PATCH(req: NextRequest) { return withApiHandling(async () => {
  const auth = await authorize(req);
  const body = await parseJsonWith(req, z.object({ cancelAtPeriodEnd: z.boolean() }).strict());
  return ok(await setSubscriptionCancellation(auth.businessId, body.cancelAtPeriodEnd));
}); }
export async function DELETE(req: NextRequest) { return withApiHandling(async () => {
  const auth = await authorize(req);
  const { id } = await parseJsonWith(req, z.object({ id: z.string().uuid() }).strict());
  return ok(await cancelInvoice(auth.businessId, id));
}); }
