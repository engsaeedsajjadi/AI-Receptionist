import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const rows = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.businessId, auth.businessId))
      .orderBy(desc(knowledgeDocuments.createdAt));

    return ok(rows);
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJson<{ title: string; content: string; sourceType?: string; sourceUrl?: string }>(req);

    const [doc] = await db
      .insert(knowledgeDocuments)
      .values({
        businessId: auth.businessId,
        title: normalizePersianText(body.title),
        content: body.content,
        sourceType: body.sourceType ?? "manual",
        sourceUrl: body.sourceUrl ?? null,
      })
      .returning();

    return ok(doc, 201);
  });
}
