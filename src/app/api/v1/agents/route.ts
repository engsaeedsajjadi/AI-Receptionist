import { inventoryQuota } from "@/lib/services/quotas";
import { z } from "zod";
import { AgentConfigSchema } from "@/lib/services/agent";
import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasPermission } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { assertVoiceAllowed } from "@/lib/voice/voice-safety";

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
    if (!hasPermission(auth.role, "agents:write")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJsonWith(req, z.object({
      name: z.string().min(1).max(150), systemPrompt: z.string().max(8000).optional(),
      voiceProvider: z.enum(["generic"]).optional(), voiceId: z.string().max(100).optional(),
      language: z.string().max(20).optional(), configuration: AgentConfigSchema.optional(),
    }));

    // Voice ids are synthesis inputs: a non-publisher voice needs recorded consent.
    await assertVoiceAllowed({ businessId: auth.businessId, voiceId: body.voiceId });

    const created = await db.transaction(async (tx) => {
      await inventoryQuota(tx, auth.businessId, "active_agents", 1);
      const [created] = await tx
      .insert(agents)
      .values({
        businessId: auth.businessId,
        name: normalizePersianText(body.name),
        systemPrompt: body.systemPrompt ?? "",
        voiceProvider: body.voiceProvider ?? "generic",
        voiceId: body.voiceId ?? "fa-default",
        language: body.language ?? "fa-IR",
        configuration: AgentConfigSchema.parse(body.configuration ?? {}),
      })
      .returning();

      return created;
    });
    return ok(created, 201);
  });
}
