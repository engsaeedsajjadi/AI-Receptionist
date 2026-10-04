import { and, eq, gt, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { identityTokens, users } from "@/db/schema";
import { assertSameOrigin, buildRefreshCookie, getCookieValue, issueAuthTokens } from "@/lib/auth";
import { AppError, ok, parseJsonWith } from "@/lib/api";
import { digestIdentity } from "@/lib/mfa";
import { redisGet, redisDel } from "@/lib/redis";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { verifyMfaLogin } from "@/lib/services/identity";
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    if (!req.headers.get("origin")) throw new AppError(403, "FORBIDDEN", "Origin required");
    assertSameOrigin(req); await enforceRateLimit(req, "login");
    const challenge = getCookieValue(req, "ar_oauth_mfa");
    if (!challenge) throw new AppError(401, "UNAUTHORIZED", "Login challenge missing");
    const hash = digestIdentity(challenge);
    await enforceRateLimit(req, "login", `oauth:${hash}`);
    const { code } = await parseJsonWith(req, z.object({ code: z.string().min(6).max(100) }));
    const [ticket] = await db.select().from(identityTokens).where(and(eq(identityTokens.tokenHash, hash), eq(identityTokens.purpose, "oauth_mfa"), isNull(identityTokens.consumedAt), gt(identityTokens.expiresAt, new Date()))).limit(1);
    if (!ticket) throw new AppError(401, "UNAUTHORIZED", "Login challenge expired");
    const version = await redisGet(`oauth:version:${hash}`);
    if (version === null) throw new AppError(401, "UNAUTHORIZED", "Login challenge expired");
    await verifyMfaLogin(ticket.userId, code);
    const consumed = await db.update(identityTokens).set({ consumedAt: new Date() }).where(and(eq(identityTokens.id, ticket.id), isNull(identityTokens.consumedAt))).returning();
    if (!consumed.length) throw new AppError(401, "UNAUTHORIZED", "Login challenge consumed");
    await redisDel(`oauth:version:${hash}`);
    const [user] = await db.select().from(users).where(eq(users.id, ticket.userId)).limit(1);
    const tokens = await issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role, credentialVersion: Number(version), userAgent: req.headers.get("user-agent") ?? undefined });
    const response = ok({ ok: true }); response.headers.append("Set-Cookie", buildRefreshCookie(tokens.refreshToken));
    response.headers.append("Set-Cookie", `ar_oauth_mfa=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return response;
  });
}
