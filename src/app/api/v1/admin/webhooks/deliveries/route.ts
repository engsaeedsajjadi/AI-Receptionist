import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseJsonWith, parseWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { DeliveryQuerySchema, listWebhookDeliveries, requeueWebhookDelivery } from "@/lib/services/tenant-webhooks";

/** Delivery log + dead-letter requeue for outbound webhooks. */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const url = new URL(req.url);
    const query = parseWith(DeliveryQuerySchema, Object.fromEntries(url.searchParams.entries()));
    return ok({ deliveries: await listWebhookDeliveries(auth.businessId, query) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { deliveryId } = await parseJsonWith(req, z.object({ deliveryId: z.string().uuid() }).strict());
    return ok(await requeueWebhookDelivery(auth.businessId, deliveryId));
  });
}
