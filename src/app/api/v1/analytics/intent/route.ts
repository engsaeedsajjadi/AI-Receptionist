import { NextRequest } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import { ApiError, ok, parseWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { CALLER_INTENTS, intentSummary, type CallerIntent, type ResolvedIntent } from "@/lib/services/conversation-intelligence";
import { withApiHandling } from "@/lib/server-core";

/**
 * Tenant-scoped AI quality report for caller intents.
 *
 * The typed intent boundary resolves every turn deterministically and stores the
 * decision (never the utterance, never slot values) on the agent's transcript
 * row. This endpoint aggregates those decisions so a tenant can see how often the
 * assistant failed to understand a caller and which intents it misreads. It is
 * strictly tenant-scoped: the query filters `call_messages.business_id` *and*
 * joins `calls` on the same business id.
 */

const QuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  })
  .strict();

type IntentMetadata = {
  intent?: string;
  confidence?: number;
  actionable?: boolean;
  needsClarification?: boolean;
  reason?: string;
  slotKeys?: string[];
};

function toResolved(metadata: IntentMetadata): ResolvedIntent | null {
  if (!metadata.intent || !(CALLER_INTENTS as readonly string[]).includes(metadata.intent)) return null;
  return {
    intent: metadata.intent as CallerIntent,
    confidence: typeof metadata.confidence === "number" ? metadata.confidence : 0,
    slots: {},
    actionable: metadata.actionable === true,
    needsClarification: metadata.needsClarification === true,
    reason: typeof metadata.reason === "string" ? metadata.reason : "unknown",
  };
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "ai");
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "agents:read")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const url = new URL(req.url);
    const query = parseWith(QuerySchema, {
      days: url.searchParams.get("days") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    const since = new Date(Date.now() - query.days * 86_400_000);
    const rows = await db
      .select({ metadata: callMessages.metadata, callId: callMessages.callId, createdAt: callMessages.timestamp })
      .from(callMessages)
      .innerJoin(calls, and(eq(calls.id, callMessages.callId), eq(calls.businessId, callMessages.businessId)))
      .where(and(
        eq(callMessages.businessId, auth.businessId),
        eq(callMessages.role, "AGENT"),
        gte(callMessages.timestamp, since),
        sql`${callMessages.metadata} ? 'intent'`,
      ))
      .orderBy(desc(callMessages.timestamp))
      .limit(query.limit);

    const items: ResolvedIntent[] = [];
    let withSlots = 0;
    for (const row of rows) {
      const metadata = (row.metadata as { intent?: IntentMetadata }).intent;
      const resolved = metadata ? toResolved(metadata) : null;
      if (!resolved) continue;
      if ((metadata?.slotKeys?.length ?? 0) > 0) withSlots += 1;
      items.push(resolved);
    }

    const summary = intentSummary(items);
    return ok({
      window: { days: query.days, since: since.toISOString() },
      calls: new Set(rows.map((row) => row.callId)).size,
      turns: items.length,
      withSlots,
      ...summary,
      /**
       * Intents the assistant could not act on (low confidence, or a
       * side-effecting request that must be confirmed), worst first. This is the
       * honest measure: `needsClarification` is only set when a model proposal was
       * rejected, while local resolution reports `actionable: false` directly.
       */
      unactionableByIntent: items
        .filter((item) => !item.actionable)
        .reduce<Array<{ intent: CallerIntent; count: number }>>((acc, item) => {
          const found = acc.find((entry) => entry.intent === item.intent);
          if (found) found.count += 1;
          else acc.push({ intent: item.intent, count: 1 });
          return acc;
        }, [])
        .sort((a, b) => b.count - a.count),
    });
  });
}
