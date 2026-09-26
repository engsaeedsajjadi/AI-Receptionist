import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { SchedulingConfigSchema } from "@/lib/services/appointments";
import { normalizePhone } from "@/lib/normalization";

const transferSchema = z.object({
  number: z.string().max(30).optional(),
  fallbackNumber: z.string().max(30).optional(),
  timeoutSeconds: z.number().int().min(5).max(120).optional(),
});

const settingsSchema = z.object({
  settings: z
    .object({
      recording_enabled: z.boolean().optional(),
      transcription_enabled: z.boolean().optional(),
      retention_days: z.number().int().min(1).max(3650).optional(),
      disclosure_message: z.string().max(500).optional(),
      scheduling: SchedulingConfigSchema.optional(),
      transfer: transferSchema.optional(),
    })
    .catchall(z.unknown()),
});

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const [business] = await db.select().from(businesses).where(eq(businesses.id, auth.businessId)).limit(1);
    return ok({ settings: business?.settings ?? {} });
  });
}

export async function PUT(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJsonWith(req, settingsSchema);

    // Normalize transfer numbers eagerly so the handoff path can trust them.
    const settings = { ...(body.settings as Record<string, unknown>) };
    if (settings.transfer && typeof settings.transfer === "object") {
      const t = settings.transfer as Record<string, unknown>;
      if (typeof t.number === "string") t.number = normalizePhone(t.number) ?? t.number;
      if (typeof t.fallbackNumber === "string") t.fallbackNumber = normalizePhone(t.fallbackNumber) ?? t.fallbackNumber;
    }

    const [current] = await db
      .select({ settings: businesses.settings })
      .from(businesses)
      .where(eq(businesses.id, auth.businessId))
      .limit(1);
    const merged = { ...((current?.settings as Record<string, unknown>) ?? {}), ...settings };

    const [updated] = await db
      .update(businesses)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(businesses.id, auth.businessId))
      .returning();

    return ok({ settings: updated.settings });
  });
}
