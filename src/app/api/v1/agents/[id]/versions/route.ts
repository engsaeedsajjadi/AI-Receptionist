import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agentVersions } from "@/db/schema";
import { getAuthContext } from "@/lib/auth";
import { ok } from "@/lib/api";
import { withApiHandling } from "@/lib/server-core";
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const versions = await db.select().from(agentVersions).where(and(eq(agentVersions.businessId, auth.businessId), eq(agentVersions.agentId, id))).orderBy(desc(agentVersions.createdAt)).limit(100);
    return ok({ versions });
  });
}
