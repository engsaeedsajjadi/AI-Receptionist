import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { callMessages, calls, retrievalEvents, usageRecords } from "@/db/schema";
import { AppError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) {
      throw new AppError(400, "BAD_REQUEST", "Invalid call id");
    }

    const [call] = await db.select().from(calls)
      .where(and(eq(calls.id, id), eq(calls.businessId, auth.businessId)))
      .limit(1);
    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

    const [messageRows, usage, retrieval] = await Promise.all([
      db.select({
        id: callMessages.id,
        role: callMessages.role,
        content: callMessages.content,
        timestamp: callMessages.timestamp,
        seq: callMessages.seq,
        metadata: callMessages.metadata,
      }).from(callMessages)
        .where(and(eq(callMessages.callId, id), eq(callMessages.businessId, auth.businessId)))
        .orderBy(desc(callMessages.timestamp)).limit(100),
      db.select({
        id: usageRecords.id,
        type: usageRecords.type,
        quantity: usageRecords.quantity,
        unit: usageRecords.unit,
        provider: usageRecords.provider,
        estimatedCost: usageRecords.estimatedCost,
        metadata: usageRecords.metadata,
        createdAt: usageRecords.createdAt,
      }).from(usageRecords)
        .where(and(
          eq(usageRecords.businessId, auth.businessId),
          sql`${usageRecords.metadata}->>'callId' = ${id}`,
        ))
        .orderBy(desc(usageRecords.createdAt)).limit(100),
      db.select({
        id: retrievalEvents.id,
        outcome: retrievalEvents.outcome,
        candidateCount: retrievalEvents.candidateCount,
        resultCount: retrievalEvents.resultCount,
        documentIds: retrievalEvents.documentIds,
        usedDocumentIds: retrievalEvents.usedDocumentIds,
        reranker: retrievalEvents.reranker,
        retrievalMs: retrievalEvents.retrievalMs,
        createdAt: retrievalEvents.createdAt,
      }).from(retrievalEvents)
        .where(and(eq(retrievalEvents.businessId, auth.businessId), eq(retrievalEvents.callId, id)))
        .orderBy(desc(retrievalEvents.createdAt)).limit(20),
    ]);

    return ok({
      call,
      messages: messageRows.reverse(),
      usage,
      retrieval,
      serverTime: new Date().toISOString(),
    });
  });
}
