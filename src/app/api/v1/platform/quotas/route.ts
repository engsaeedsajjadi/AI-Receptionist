import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
import { requirePlatformAdmin } from "@/lib/services/platform";
import { updateQuotaOverride, OverrideSchema } from "@/lib/services/quotas";
import { db } from "@/db";

/** Platform-only: quota overrides are a platform control, never tenant-editable. */
export async function PATCH(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    // Authorize before parsing so a tenant admin receives 403, not a 400.
    await requirePlatformAdmin(db, auth.userId);
    return ok(await updateQuotaOverride(auth.userId, await parseJsonWith(req, OverrideSchema)));
  });
}
