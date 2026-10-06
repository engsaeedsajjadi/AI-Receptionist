import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { agentVersions, agents, auditLogs, businesses } from "@/db/schema";
import { AppError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasPermission } from "@/lib/permissions";
import { AgentConfigSchema } from "@/lib/services/agent";
import { inventoryQuota } from "@/lib/services/quotas";
import { requestContext } from "@/lib/request-context";
import { withApiHandling } from "@/lib/server-core";
import { assertVoiceAllowed } from "@/lib/voice/voice-safety";

const snapshotSchema = z.object({
  name: z.string().min(1).max(150),
  systemPrompt: z.string().max(8000).default(""),
  voiceProvider: z.string().min(1).max(100).default("generic"),
  voiceId: z.string().min(1).max(100).default("fa-default"),
  language: z.string().min(1).max(20).default("fa-IR"),
  isActive: z.boolean().default(true),
  configuration: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; versionId: string }> },
) {
  return withApiHandling(async () => {
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "agents:write")) {
      throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    }
    const { id, versionId } = await ctx.params;

    const [version] = await db
      .select()
      .from(agentVersions)
      .where(and(
        eq(agentVersions.id, versionId),
        eq(agentVersions.agentId, id),
        eq(agentVersions.businessId, auth.businessId),
      ))
      .limit(1);
    if (!version) throw new AppError(404, "NOT_FOUND", "Agent version not found");

    const parsed = snapshotSchema.safeParse(version.snapshot);
    if (!parsed.success) {
      throw new AppError(409, "CONFLICT", "Stored agent version is not compatible with the current schema");
    }
    const config = AgentConfigSchema.safeParse({ agentName: parsed.data.name, ...parsed.data.configuration });
    if (!config.success) {
      throw new AppError(409, "CONFLICT", "Stored agent configuration is no longer valid");
    }
    await assertVoiceAllowed({ businessId: auth.businessId, voiceId: parsed.data.voiceId });

    const updated = await db.transaction(async (tx) => {
      await tx.select({ id: businesses.id }).from(businesses)
        .where(eq(businesses.id, auth.businessId)).for("update");
      const [current] = await tx.select().from(agents)
        .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId)))
        .for("update").limit(1);
      if (!current) throw new AppError(404, "AGENT_NOT_FOUND", "Agent not found");

      if (parsed.data.isActive && !current.isActive) {
        await inventoryQuota(tx, auth.businessId, "active_agents", 1);
      }
      await tx.insert(agentVersions).values({
        businessId: auth.businessId,
        agentId: id,
        createdBy: auth.userId,
        snapshot: JSON.parse(JSON.stringify(current)),
      });

      const [row] = await tx.update(agents).set({
        name: normalizePersianText(parsed.data.name),
        systemPrompt: parsed.data.systemPrompt,
        voiceProvider: parsed.data.voiceProvider,
        voiceId: parsed.data.voiceId,
        language: parsed.data.language,
        isActive: parsed.data.isActive,
        configuration: config.data as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      }).where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId))).returning();

      await tx.insert(auditLogs).values({
        businessId: auth.businessId,
        actorType: "user",
        actorId: auth.userId,
        action: "agent.version_restored",
        entityType: "agent",
        entityId: id,
        requestId: requestContext.getStore()?.requestId,
        metadata: { restoredVersionId: versionId },
      });
      return row;
    });

    return ok(updated);
  });
}
