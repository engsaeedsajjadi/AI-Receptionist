import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { authenticateApiKey } from "@/lib/services/access";
import { assertScimScope, scimCreateUser, scimListUsers, scimUserResource, ScimUserSchema, SCIM_SCOPE } from "@/lib/services/identity-provisioning";

/**
 * SCIM 2.0 User provisioning.
 *
 * Authentication is a tenant API key carrying the `scim:provision` scope —
 * there is no secret in the URL and no cross-tenant lookup by external id.
 */
async function authorize(req: NextRequest) {
  await enforceRateLimit(req, "admin");
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const auth = await authenticateApiKey(presented);
  if (!auth) throw new AppError(401, "UNAUTHORIZED", "Invalid SCIM credential");
  // Service accounts authenticate as their creating user in audit terms.
  const { apiKeys } = await import("@/db/schema");
  const { db } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select({ createdBy: apiKeys.createdBy }).from(apiKeys).where(eq(apiKeys.id, auth.keyId));
  const actor = { userId: row?.createdBy ?? auth.businessId, businessId: auth.businessId, scopes: auth.scopes };
  await assertScimScope(actor);
  return actor;
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    const actor = await authorize(req);
    const url = new URL(req.url);
    const result = await scimListUsers(actor.businessId, Object.fromEntries(url.searchParams.entries()));
    return ok(result);
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const actor = await authorize(req);
    const body = await parseJsonWith(req, ScimUserSchema);
    const { created, user } = await scimCreateUser(actor, body);
    const url = new URL(req.url);
    return ok({ ...scimUserResource(user, `${url.protocol}//${url.host}`), "urn:receptionist:created": created }, created ? 201 : 200);
  });
}

export { SCIM_SCOPE };
