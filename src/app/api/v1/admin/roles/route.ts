import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { createRole, listRoles, RoleCreateSchema, RoleUpdateSchema, updateRole } from "@/lib/services/access";

/** Custom roles (RBAC). Tenant administrators cannot grant platform privileges. */
async function authorize(req: NextRequest) {
  await checkGlobalPublicRateLimit(req);
  const auth = await getAuthContext(req);
  if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
  return auth;
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    return ok({ roles: await listRoles(auth.businessId) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, RoleCreateSchema);
    const role = await createRole({ userId: auth.userId, businessId: auth.businessId, platform: auth.role === "SUPER_ADMIN" }, body);
    return ok(role, 201);
  });
}

export async function PATCH(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, RoleUpdateSchema);
    const role = await updateRole({ userId: auth.userId, businessId: auth.businessId, platform: auth.role === "SUPER_ADMIN" }, body);
    return ok(role);
  });
}
