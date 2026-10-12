import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { identityTokens, oauthAccounts, users } from "@/db/schema";
import { buildRefreshCookie, getCookieValue, issueAuthTokens } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { digestIdentity } from "@/lib/mfa";
import { finishOAuth, oauthCallbackUrl, oauthCookie, oauthProvider } from "@/lib/oidc";
import { withApiHandling } from "@/lib/server-core";
import { redisSet } from "@/lib/redis";
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  return withApiHandling(async () => {
    const provider = oauthProvider((await ctx.params).provider);
    const callback = oauthCallbackUrl(provider); callback.search = req.nextUrl.search;
    const { flow, issuer, subject } = await finishOAuth(provider, callback, getCookieValue(req, "ar_oidc"));
    let userId: string;
    if (flow.userId && flow.businessId) {
      await db.transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(and(eq(users.id, flow.userId!), eq(users.businessId, flow.businessId!))).for("update").limit(1);
        if (!user?.isActive || user.credentialVersion !== flow.credentialVersion) throw new AppError(401, "UNAUTHORIZED", "Sign in again to link this account");
        const [existing] = await tx.select().from(oauthAccounts).where(and(eq(oauthAccounts.issuer, issuer), eq(oauthAccounts.subject, subject))).limit(1);
        if (existing && existing.userId !== user.id) throw new AppError(409, "CONFLICT", "External identity is already linked");
        const [linked] = await tx.select().from(oauthAccounts).where(and(eq(oauthAccounts.userId, user.id), eq(oauthAccounts.provider, provider))).limit(1);
        if (linked && (linked.subject !== subject || linked.issuer !== issuer)) throw new AppError(409, "CONFLICT", "A different identity is already linked to this provider");
        await tx.insert(oauthAccounts).values({ userId: user.id, businessId: user.businessId, provider, subject, issuer }).onConflictDoNothing();
        const [saved] = await tx.select().from(oauthAccounts).where(and(eq(oauthAccounts.issuer, issuer), eq(oauthAccounts.subject, subject))).limit(1);
        if (!saved || saved.userId !== user.id) throw new AppError(409, "CONFLICT", "External identity was linked by another account");
      });
      return new Response(null, { status: 302, headers: { Location: new URL("/dashboard/security", process.env.APP_URL ?? "http://localhost:3000").href, "Set-Cookie": oauthCookie("", 0) } });
    }
    const [account] = await db.select().from(oauthAccounts).where(and(eq(oauthAccounts.issuer, issuer), eq(oauthAccounts.subject, subject))).limit(1);
    if (!account) throw new AppError(403, "FORBIDDEN", "Sign in with your password first and link this provider from Security settings");
    userId = account.userId;
    const [user] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.businessId, account.businessId))).limit(1);
    if (!user?.isActive) throw new AppError(401, "UNAUTHORIZED", "User inactive");
    const response = new Response(null, { status: 302 });
    response.headers.append("Set-Cookie", oauthCookie("", 0));
    if (user.mfaEnabled) {
      const challenge = randomBytes(32).toString("base64url");
      await db.insert(identityTokens).values({ businessId: user.businessId, userId: user.id, purpose: "oauth_mfa", tokenHash: digestIdentity(challenge), expiresAt: new Date(Date.now() + 300000) });
      await redisSet(`oauth:version:${digestIdentity(challenge)}`, String(user.credentialVersion), 300);
      response.headers.append("Set-Cookie", `ar_oauth_mfa=${challenge}; HttpOnly; Path=/; SameSite=Lax; Max-Age=300${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      response.headers.set("Location", new URL("/account/oauth", process.env.APP_URL ?? "http://localhost:3000").href);
    } else {
      const tokens = await issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role, credentialVersion: user.credentialVersion, userAgent: req.headers.get("user-agent") ?? undefined });
      response.headers.append("Set-Cookie", buildRefreshCookie(tokens.refreshToken));
      response.headers.set("Location", new URL("/dashboard", process.env.APP_URL ?? "http://localhost:3000").href);
    }
    return response;
  });
}
