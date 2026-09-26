import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { hybridSearch } from "@/lib/services/knowledge";
import { withApiHandling } from "@/lib/server-core";

const searchSchema = z.object({
  query: z.string().min(2).max(500),
  topK: z.number().int().min(1).max(20).default(5),
});

/** Hybrid RAG retrieval (vector + keyword, tenant-scoped). */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "ai");
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, searchSchema);
    const result = await hybridSearch({
      businessId: auth.businessId,
      query: body.query,
      topK: body.topK,
      requestId: rid,
    });
    return ok(result);
  });
}
