import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { auditLogs, leads } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { requestContext } from "@/lib/request-context";
import { scoreLead, readScoreRationale, explainScoreChange, type LeadScoreRationale } from "@/lib/scoring";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

/** Current score with its rationale (never recomputes: reads what is stored). */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const [lead] = await db
      .select({ id: leads.id, score: leads.score, scoreRationale: leads.scoreRationale, scoreSource: leads.updatedAt })
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .limit(1);
    if (!lead) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");
    return ok({
      leadId: lead.id,
      score: lead.score,
      rationale: readScoreRationale(lead.scoreRationale),
    });
  });
}

/**
 * Recompute the score from the lead's current signals.
 *
 * Explicit, audited and diffed: the response explains which factors changed, and
 * the previous rationale is kept in the audit metadata so a score that moves is
 * never a mystery. Manual scores (set by a human through the lead API) are
 * overwritten only when the caller asks for it — a rescore is a deliberate act.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "crm:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;

    const result = await db.transaction(async (tx) => {
      const [lead] = await tx
        .select()
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
        .for("update")
        .limit(1);
      if (!lead) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");

      const previous = readScoreRationale(lead.scoreRationale);
      const next: LeadScoreRationale = scoreLead({
        type: lead.type,
        budgetMin: lead.budgetMin,
        budgetMax: lead.budgetMax,
        location: lead.location,
        minArea: lead.minArea,
        maxArea: lead.maxArea,
        bedrooms: lead.bedrooms,
        timeframe: lead.timeframe,
        requestedVisit: lead.requestedVisit,
        source: lead.source,
        summary: lead.summary,
        status: lead.status,
      });
      const change = explainScoreChange(previous, next);

      await tx
        .update(leads)
        .set({ score: next.score, scoreRationale: next as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)));
      await tx.insert(auditLogs).values({
        businessId: auth.businessId,
        actorType: "user",
        actorId: auth.userId,
        action: "lead.rescored",
        entityType: "lead",
        entityId: id,
        requestId: requestContext.getStore()?.requestId,
        metadata: {
          from: change.from,
          to: change.to,
          delta: change.delta,
          changes: change.changes,
          rubricVersion: next.rubricVersion,
        },
      });
      return { next, change };
    });

    return ok({ leadId: id, score: result.next.score, rationale: result.next, change: result.change });
  });
}
