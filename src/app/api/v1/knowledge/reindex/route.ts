import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { reindexDocument } from "@/lib/services/knowledge";
import { withApiHandling } from "@/lib/server-core";

const reindexSchema = z.object({
  documentId: z.string().uuid().optional(),
});

/**
 * Real reindex: re-chunk + re-embed one document (or all indexed/failed
 * documents of the business when documentId is omitted).
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "upload");
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJsonWith(req, reindexSchema).catch(() => ({ documentId: undefined as string | undefined }));

    if (body.documentId) {
      const result = await reindexDocument(auth.businessId, body.documentId, { requestId: rid });
      return ok({ ok: true, indexed_documents: 1, chunks: result.chunks, mode: "vector" });
    }

    const docs = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.businessId, auth.businessId));

    let indexed = 0;
    let failed = 0;
    for (const doc of docs) {
      try {
        await reindexDocument(auth.businessId, doc.id, { requestId: rid });
        indexed++;
      } catch {
        failed++;
      }
    }
    return ok({ ok: true, indexed_documents: indexed, failed_documents: failed, mode: "vector" });
  });
}
