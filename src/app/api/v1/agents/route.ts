import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.businessId, auth.businessId))
      .orderBy(desc(agents.createdAt));

    return ok(rows);
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJson<{
      name: string;
      systemPrompt?: string;
      voiceProvider?: string;
      voiceId?: string;
      language?: string;
      configuration?: Record<string, unknown>;
    }>(req);

    const [created] = await db
      .insert(agents)
      .values({
        businessId: auth.businessId,
        name: normalizePersianText(body.name),
        systemPrompt: body.systemPrompt ?? "",
        voiceProvider: body.voiceProvider ?? "mock",
        voiceId: body.voiceId ?? "fa-default",
        language: body.language ?? "fa-IR",
        configuration: body.configuration ?? {},
      })
      .returning();

    return ok(created, 201);
  });
}
