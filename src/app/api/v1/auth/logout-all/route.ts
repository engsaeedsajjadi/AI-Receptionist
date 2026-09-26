import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { getAuthContext, revokeAllSessions } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

/** Revoke every refresh token for the authenticated user (logout everywhere). */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const revoked = await revokeAllSessions(auth.userId);
    return ok({ ok: true, revokedSessions: revoked });
  });
}
