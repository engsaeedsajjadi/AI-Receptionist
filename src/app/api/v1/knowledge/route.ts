import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import { ApiError, ok, paginated, parseJsonWith, parsePagination } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { ingestContent } from "@/lib/services/knowledge";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { page, limit, offset } = parsePagination(req);

    const rows = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.businessId, auth.businessId))
      .orderBy(desc(knowledgeDocuments.createdAt))
      .limit(limit)
      .offset(offset);

    return ok(paginated(rows, page, limit, rows.length < limit ? offset + rows.length : (page + 1) * limit));
  });
}

const createSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(20).max(500_000),
  sourceType: z.string().max(50).optional(),
  sourceUrl: z.string().url().max(2048).optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "upload");
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "knowledge:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJsonWith(req, createSchema);
    const result = await ingestContent({
      businessId: auth.businessId,
      title: body.title,
      content: body.content,
      sourceType: body.sourceType,
      sourceUrl: body.sourceUrl,
      requestId: rid,
    });
    return ok({ document: result.document, chunks: result.chunks }, 201);
  });
}
