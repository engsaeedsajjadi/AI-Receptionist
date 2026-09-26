import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { assertUserInBusiness, getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const body = await parseJsonWith(req, z.object({ userId: z.string().uuid() }));
    await assertUserInBusiness(auth.businessId, body.userId);

    const [updated] = await db
      .update(leads)
      .set({ assignedUserId: body.userId, updatedAt: new Date() })
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .returning();

    if (!updated) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");
    return ok(updated);
  });
}
