import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasPermission } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { deleteDocument, reindexDocument } from "@/lib/services/knowledge";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;

    const [doc] = await db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.businessId, auth.businessId)))
      .limit(1);

    if (!doc) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
    return ok(doc);
  });
}

const updateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  content: z.string().min(20).max(500_000).optional(),
  sourceUrl: z.string().url().max(2048).optional(),
});

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "knowledge:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const body = await parseJsonWith(req, updateSchema);

    const [existing] = await db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.businessId, auth.businessId)))
      .limit(1);
    if (!existing) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");

    const [updated] = await db
      .update(knowledgeDocuments)
      .set({
        title: body.title ? normalizePersianText(body.title) : undefined,
        content: body.content,
        status: body.content ? "indexing" : undefined,
        sourceUrl: body.sourceUrl,
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.businessId, auth.businessId)))
      .returning();

    // Content edits invalidate embeddings → reindex with the real pipeline.
    if (body.content) {
      await reindexDocument(auth.businessId, id, { requestId: rid });
      const [doc] = await db.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.businessId, auth.businessId))).limit(1);
      return ok(doc);
    }
    return ok(updated);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "knowledge:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    await deleteDocument(auth.businessId, id);
    return ok({ ok: true });
  });
}
