import { NextRequest } from "next/server";
import { db } from "@/db";
import { knowledgeChunks, knowledgeDocuments } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJson<{ title: string; content: string; sourceType?: "TXT" | "PDF" | "DOCX" | "MARKDOWN" }>(req);

    const [doc] = await db
      .insert(knowledgeDocuments)
      .values({
        businessId: auth.businessId,
        title: normalizePersianText(body.title),
        sourceType: body.sourceType ?? "TXT",
        content: body.content,
      })
      .returning();

    const chunks = body.content
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .slice(0, 50);

    if (chunks.length > 0) {
      await db.insert(knowledgeChunks).values(
        chunks.map((chunk, idx) => ({
          documentId: doc.id,
          content: chunk,
          metadata: { chunk_index: idx },
        })),
      );
    }

    return ok({ document: doc, chunks: chunks.length }, 201);
  });
}
