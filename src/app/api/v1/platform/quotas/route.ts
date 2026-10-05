import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
import { updateQuotaOverride, OverrideSchema } from "@/lib/services/quotas";
export async function PATCH(req: NextRequest) { return withApiHandling(async () => {
  await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
  return ok(await updateQuotaOverride(auth.userId, await parseJsonWith(req, OverrideSchema)));
}); }
