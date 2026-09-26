import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const docs = await db.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, auth.businessId));
    return ok({ ok: true, indexed_documents: docs.length, mode: "fts-placeholder" });
  });
}
