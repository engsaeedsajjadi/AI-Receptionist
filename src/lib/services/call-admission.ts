import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, businesses, calls, usageRecords, webhookEvents } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { assertTenantScope } from "@/lib/request-context";
import { tenantFeaturesSchema } from "@/lib/tenant-config";
import { consumeUsageInTransaction } from "@/lib/services/quotas";
export async function registerInboundCall(input: {
  businessId: string; externalCallId: string; phoneNumber: string; agentId?: string;
  direction: "INBOUND" | "OUTBOUND"; metadata: Record<string, unknown>; idempotencyKey: string;
}) {
  assertTenantScope(input.businessId); z.string().min(1).max(255).parse(input.idempotencyKey);
  const scope = `voice:call-started:${input.businessId}`;
  const payloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return db.transaction(async tx => {
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).for("update");
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
    if (!business.isActive) throw new AppError(403, "FORBIDDEN", "Business is inactive");
    if (!tenantFeaturesSchema.parse(business.settings.features ?? {}).voice) throw new AppError(403, "FORBIDDEN", "Voice is disabled for this tenant");
    if (input.agentId) {
      const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.businessId, input.businessId), eq(agents.isActive, true)));
      if (!agent) throw new AppError(404, "AGENT_NOT_FOUND", "Active tenant agent not found");
    }
    const [event] = await tx.select().from(webhookEvents).where(and(eq(webhookEvents.businessId, input.businessId), eq(webhookEvents.scope, scope), eq(webhookEvents.idempotencyKey, input.idempotencyKey)));
    if (event && event.payloadHash !== payloadHash) throw new AppError(409, "CONFLICT", "Webhook key reused for a different payload");
    const [existing] = await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.businessId, input.businessId), eq(calls.externalCallId, input.externalCallId)));
    if (event && !existing) throw new AppError(409, "CONFLICT", "Processed call no longer exists");
    if (!event) await tx.insert(webhookEvents).values({ businessId: input.businessId, scope, idempotencyKey: input.idempotencyKey, payloadHash });
    if (existing) return { callId: existing.id, created: false, settings: business.settings };
    const [call] = await tx.insert(calls).values({ businessId: input.businessId, externalCallId: input.externalCallId,
      phoneNumber: input.phoneNumber, agentId: input.agentId ?? null, direction: input.direction, status: "RINGING", startedAt: new Date(),
      metadata: { ...input.metadata, idempotencyKey: input.idempotencyKey } }).returning({ id: calls.id });
    await consumeUsageInTransaction(tx, input.businessId, "calls", 1, `call-admission:${call.id}`);
    await tx.insert(usageRecords).values({ businessId: input.businessId, type: "calls", quantity: "1", unit: "count",
      idempotencyKey: `call-started:${call.id}`, metadata: { event: "call_started", callId: call.id, externalCallId: input.externalCallId } });
    return { callId: call.id, created: true, settings: business.settings };
  });
}
