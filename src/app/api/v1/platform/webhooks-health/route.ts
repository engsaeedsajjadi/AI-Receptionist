import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { requirePlatformAdmin } from "@/lib/services/platform";
import { webhookHealth } from "@/lib/services/tenant-webhooks";
import { outboxHealth } from "@/lib/services/outbox";
import { db } from "@/db";

/** Platform view of outbound webhook and outbox delivery health. */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    await requirePlatformAdmin(db, auth.userId);
    return ok({ webhooks: await webhookHealth(), outbox: await outboxHealth() });
  });
}
