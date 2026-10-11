import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { readConsent, recordVoiceCloningConsent, revokeVoiceCloningConsent, isCloningEnabled } from "@/lib/voice/voice-safety";

/**
 * Voice-cloning consent record for the calling tenant.
 *
 * A consent record is necessary but not sufficient to use a cloned voice: the
 * platform opt-in (`VOICE_CLONING_ENABLED`) must also be on, and every voice use
 * is re-checked at synthesis time.
 */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const [row] = await db
      .select({ settings: businesses.settings })
      .from(businesses)
      .where(eq(businesses.id, auth.businessId))
      .limit(1);
    return ok({ cloningEnabled: isCloningEnabled(), consent: readConsent(row?.settings as Record<string, unknown>) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(
      req,
      z.object({
        subject: z.string().trim().min(2).max(200),
        reference: z.string().trim().min(3).max(200),
        voiceIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
      }),
    );
    const consent = await recordVoiceCloningConsent({
      businessId: auth.businessId,
      userId: auth.userId,
      subject: body.subject,
      reference: body.reference,
      voiceIds: body.voiceIds,
    });
    return ok({ consent, cloningEnabled: isCloningEnabled() }, 201);
  });
}

export async function DELETE(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    await revokeVoiceCloningConsent({ businessId: auth.businessId, userId: auth.userId });
    return ok({ revoked: true });
  });
}
