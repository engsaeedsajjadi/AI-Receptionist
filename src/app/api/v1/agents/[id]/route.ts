import { inventoryQuota } from "@/lib/services/quotas";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses, agents, agentVersions } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasPermission } from "@/lib/permissions";
import { AgentConfigSchema } from "@/lib/services/agent";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
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

const updateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  systemPrompt: z.string().max(8000).optional(),
  voiceProvider: z.enum(["generic"]).optional(),
  voiceId: z.string().max(100).optional(),
  language: z.string().max(20).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "agents:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const body = await parseJson<Record<string, unknown>>(req);
    const parsed = updateSchema.parse(body);

    const [existing] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .limit(1);
    if (!existing) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");

    // Merge configuration and validate known fields (business config can
    // never override hard system guardrails — those live in the prompt layer).
    let configuration = existing.configuration as Record<string, unknown>;
    if (parsed.configuration) {
      const merged = { ...configuration, ...parsed.configuration };
      const validated = AgentConfigSchema.safeParse({ agentName: parsed.name ?? existing.name, ...merged });
      if (!validated.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid agent configuration", {
          issues: validated.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      configuration = validated.data as unknown as Record<string, unknown>;
    }

    const updated = await db.transaction(async (tx) => {
      await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, auth.businessId)).for("update");
      const [current] = await tx.select().from(agents).where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId))).for("update").limit(1);
      if (!current) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
      if (current.updatedAt.getTime() !== existing.updatedAt.getTime()) throw new ApiError(409, "CONFLICT", "Agent was changed by another request; reload and retry");
      if (parsed.isActive === true && !current.isActive) await inventoryQuota(tx, auth.businessId, "active_agents", 1);
      await tx.insert(agentVersions).values({ businessId: auth.businessId, agentId: id, createdBy: auth.userId, snapshot: JSON.parse(JSON.stringify(current)) });
    const [updated] = await tx
      .update(agents)
      .set({
        name: parsed.name ? normalizePersianText(parsed.name) : undefined,
        systemPrompt: parsed.systemPrompt,
        voiceProvider: parsed.voiceProvider,
        voiceId: parsed.voiceId,
        language: parsed.language,
        configuration,
        isActive: parsed.isActive,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .returning();

      return updated;
    });

    return ok(updated);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "agents:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const deleted = await db
      .delete(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
      .returning();
    if (!deleted.length) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");

    return ok({ ok: true });
  });
}
