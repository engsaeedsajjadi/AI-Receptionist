import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { ingestContent, ingestFile } from "@/lib/services/knowledge";
import { withApiHandling } from "@/lib/server-core";

const jsonSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(20).max(500_000),
  sourceType: z.string().max(50).optional(),
  sourceUrl: z.string().url().max(2048).optional(),
});

/**
 * Knowledge ingestion.
 * - multipart/form-data with `file` (+ optional `title`): PDF/DOCX/TXT/MD pipeline
 * - application/json { title, content, ... }: manual text ingestion
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "upload");
    const auth = await getAuthContext(req);
    if (!hasPermission(auth.role, "knowledge:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const title = form.get("title");
      if (!(file instanceof File)) throw new ApiError(400, "INVALID_PAYLOAD", "Missing file field");
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await ingestFile({
        businessId: auth.businessId,
        title: typeof title === "string" && title ? title : undefined,
        buffer,
        filename: file.name || "upload",
        mimeType: file.type || "application/octet-stream",
        requestId: rid,
      });
      return ok({ document: result.document, chunks: result.chunks }, 201);
    }

    const body = jsonSchema.parse(await req.json());
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
