import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;

    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .limit(1);

    if (!row) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
    return ok(row);
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const body = await parseJson<
      Partial<{
        name: string;
        systemPrompt: string;
        voiceProvider: string;
        voiceId: string;
        language: string;
        configuration: Record<string, unknown>;
        isActive: boolean;
      }>
    >(req);

    const [updated] = await db
      .update(agents)
      .set({
        name: body.name ? normalizePersianText(body.name) : undefined,
        systemPrompt: body.systemPrompt,
        voiceProvider: body.voiceProvider,
        voiceId: body.voiceId,
        language: body.language,
        configuration: body.configuration,
        isActive: body.isActive,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .returning();

    if (!updated) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
    return ok(updated);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const deleted = await db
      .delete(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .returning();

    if (!deleted.length) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
    return ok({ ok: true });
  });
}
