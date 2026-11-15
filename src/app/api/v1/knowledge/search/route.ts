import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { KnowledgeMetadataFiltersSchema } from "@/lib/rag/access";
import { hybridSearch } from "@/lib/services/knowledge";
import { withApiHandling } from "@/lib/server-core";

const searchSchema = z.object({
  query: z.string().min(2).max(500),
  topK: z.number().int().min(1).max(20).default(5),
  /** Structured metadata filters (language, category, product, tags, …). */
  filters: KnowledgeMetadataFiltersSchema.optional(),
});

/** Hybrid RAG retrieval (vector + keyword, tenant-scoped). */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "ai");
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, searchSchema);
    // The caller's verified session role decides what this search can see: ACLs
    // are evaluated in SQL, so a document restricted to another role, user or
    // category is never a candidate (and never reaches the response body).
    const result = await hybridSearch({
      businessId: auth.businessId,
      query: body.query,
      topK: body.topK,
      requestId: rid,
      scope: {
        principal: { role: auth.role, userId: auth.userId, agentId: null, platformSupport: false },
        filters: KnowledgeMetadataFiltersSchema.parse(body.filters ?? {}),
      },
    });
    return ok(result);
  });
}
