import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { consumeIdentityLink, sendIdentityLink } from "@/lib/services/identity";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_reset"), email: z.string().email().max(255) }),
  z.object({ action: z.literal("request_verification") }),
  z.object({ action: z.literal("consume"), purpose: z.enum(["password_reset", "email_verify"]), token: z.string().min(20).max(200), password: z.string().max(128).optional() }),
]);
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");
    const body = await parseJsonWith(req, schema);
    if (body.action === "consume") await consumeIdentityLink(body.token, body.purpose, body.password);
    else if (body.action === "request_reset") await sendIdentityLink(body.email, "password_reset");
    else { const auth = await getAuthContext(req); await sendIdentityLink(auth.user.email, "email_verify", auth.userId); }
    return ok({ ok: true, message: "در صورت معتبر بودن درخواست، عملیات انجام می‌شود." });
  });
}
