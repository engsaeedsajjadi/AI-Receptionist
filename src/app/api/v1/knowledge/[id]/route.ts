import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
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

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const body = await parseJson<Partial<{ title: string; content: string; sourceUrl: string }>>(req);

    const [updated] = await db
      .update(knowledgeDocuments)
      .set({
        title: body.title ? normalizePersianText(body.title) : undefined,
        content: body.content,
        sourceUrl: body.sourceUrl,
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.businessId, auth.businessId)))
      .returning();

    if (!updated) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
    return ok(updated);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const deleted = await db
      .delete(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.businessId, auth.businessId)))
      .returning();

    if (!deleted.length) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
    return ok({ ok: true });
  });
}
