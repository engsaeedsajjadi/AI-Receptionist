import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { changePlatformTenantState, listPlatformTenants, TenantStateSchema } from "@/lib/services/platform";
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await listPlatformTenants(auth.userId, {
      after: req.nextUrl.searchParams.get("after") ?? undefined,
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    }));
  });
}
export async function PATCH(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await changePlatformTenantState(auth.userId, await parseJsonWith(req, TenantStateSchema)));
  });
}
