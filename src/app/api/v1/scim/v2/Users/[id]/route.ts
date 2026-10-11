import { NextRequest } from "next/server";
import { ok, parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { authenticateApiKey } from "@/lib/services/access";
import { assertScimScope, scimDeactivateUser, scimPatchUser, scimUserResource, ScimPatchSchema } from "@/lib/services/identity-provisioning";
import { db } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";

async function authorize(req: NextRequest) {
  await enforceRateLimit(req, "admin");
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const auth = await authenticateApiKey(presented);
  if (!auth) throw new AppError(401, "UNAUTHORIZED", "Invalid SCIM credential");
  const [row] = await db.select({ createdBy: apiKeys.createdBy }).from(apiKeys).where(eq(apiKeys.id, auth.keyId));
  const actor = { userId: row?.createdBy ?? auth.businessId, businessId: auth.businessId, scopes: auth.scopes };
  await assertScimScope(actor);
  return actor;
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    const actor = await authorize(req);
    const { id } = await context.params;
    const [user] = await db.select().from(users).where(and(eq(users.id, id), eq(users.businessId, actor.businessId)));
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
    const url = new URL(req.url);
    return ok(scimUserResource(user, `${url.protocol}//${url.host}`));
  });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    const actor = await authorize(req);
    const { id } = await context.params;
    const body = await parseJsonWith(req, ScimPatchSchema);
    const user = await scimPatchUser(actor, id, body);
    const url = new URL(req.url);
    return ok(scimUserResource(user, `${url.protocol}//${url.host}`));
  });
}

/** SCIM DELETE = deprovision (deactivate); the user record is never destroyed. */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    const actor = await authorize(req);
    const { id } = await context.params;
    const user = await scimDeactivateUser(actor, id);
    return ok({ id: user.id, active: user.isActive });
  });
}
