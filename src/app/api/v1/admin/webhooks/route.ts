import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
  WebhookEndpointSchema,
  WebhookEndpointUpdateSchema,
} from "@/lib/services/tenant-webhooks";

/**
 * Outbound tenant webhooks: HMAC-signed deliveries, per-delivery retry with
 * dead-letter, and an auditable delivery log (`/deliveries`).
 */
async function authorize(req: NextRequest) {
  await checkGlobalPublicRateLimit(req);
  const auth = await getAuthContext(req);
  if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
  return auth;
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    return ok({ endpoints: await listWebhookEndpoints(auth.businessId) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, WebhookEndpointSchema);
    return ok(await createWebhookEndpoint({ userId: auth.userId, businessId: auth.businessId }, body), 201);
  });
}

export async function PATCH(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, WebhookEndpointUpdateSchema);
    return ok(await updateWebhookEndpoint({ userId: auth.userId, businessId: auth.businessId }, body));
  });
}

export async function DELETE(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const { endpointId } = await parseJsonWith(req, WebhookEndpointUpdateSchema.pick({ endpointId: true }).required());
    return ok(await deleteWebhookEndpoint({ userId: auth.userId, businessId: auth.businessId }, endpointId));
  });
}
