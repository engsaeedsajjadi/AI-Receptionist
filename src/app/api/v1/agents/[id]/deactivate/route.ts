import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const [updated] = await db
      .update(agents)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .returning();

    if (!updated) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
    return ok(updated);
  });
}
