import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { revokeSupportSession, startSupportSession, SupportSessionStartSchema } from "@/lib/services/access";

/**
 * Read-only support access. There is no impersonation token: a support session
 * is an audited, time-boxed, read-only grant that expires on its own.
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, SupportSessionStartSchema);
    return ok(await startSupportSession({ userId: auth.userId, mfaEnabled: true }, body), 201);
  });
}

export async function DELETE(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { sessionId } = await parseJsonWith(req, z.object({ sessionId: z.string().uuid() }).strict());
    return ok(await revokeSupportSession({ userId: auth.userId }, sessionId));
  });
}
