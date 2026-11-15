import { NextRequest } from "next/server";
import { ok, parseJsonWith } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { AcceptInvitationSchema, acceptInvitation } from "@/lib/services/access";

/** Public: accept an invitation exactly once (single-use hashed token). */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");
    const body = await parseJsonWith(req, AcceptInvitationSchema);
    return ok(await acceptInvitation(body), 201);
  });
}
