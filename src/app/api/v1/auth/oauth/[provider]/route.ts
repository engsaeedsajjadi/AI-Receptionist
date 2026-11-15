import { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext, verifyPassword } from "@/lib/auth";
import { AppError, ok, parseJsonWith } from "@/lib/api";
import { oauthProvider, startOAuth } from "@/lib/oidc";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { verifyMfaLogin } from "@/lib/services/identity";
type Context = { params: Promise<{ provider: string }> };
export async function GET(req: NextRequest, context: Context) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");
    const flow = await startOAuth(oauthProvider((await context.params).provider));
    return new Response(null, { status: 302, headers: { Location: flow.url, "Set-Cookie": flow.cookie } });
  });
}
export async function POST(req: NextRequest, context: Context) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, z.object({ password: z.string().max(128), code: z.string().max(100).optional() }));
    if (!(await verifyPassword(body.password, auth.user.passwordHash))) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    await verifyMfaLogin(auth.userId, body.code);
    const flow = await startOAuth(oauthProvider((await context.params).provider), { userId: auth.userId, businessId: auth.businessId, credentialVersion: auth.user.credentialVersion });
    return ok({ url: flow.url }, 200, { "Set-Cookie": flow.cookie });
  });
}
