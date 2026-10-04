import { inventoryQuota } from "@/lib/services/quotas";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents, businesses } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "agents:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const updated = await db.transaction(async (tx) => {
      await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, auth.businessId)).for("update");
      const [current] = await tx.select().from(agents).where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId))).for("update");
      if (!current) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
      if (!current.isActive) await inventoryQuota(tx, auth.businessId, "active_agents", 1);
      const [updated] = await tx
      .update(agents)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .returning();

      return updated;
    });
    if (!updated) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
    return ok(updated);
  });
}
