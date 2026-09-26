import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const [business] = await db.select().from(businesses).where(eq(businesses.id, auth.businessId)).limit(1);
    return ok({ settings: business?.settings ?? {} });
  });
}

export async function PUT(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJson<{ settings: Record<string, unknown> }>(req);
    const [updated] = await db
      .update(businesses)
      .set({ settings: body.settings, updatedAt: new Date() })
      .where(eq(businesses.id, auth.businessId))
      .returning();

    return ok({ settings: updated.settings });
  });
}
