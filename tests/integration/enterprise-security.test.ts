import { afterAll, beforeAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { businesses, callMessages, identityTokens, refreshTokens, users } from "@/db/schema";
import { getAuthContext, issueAuthTokens, rotateRefreshToken, revokeAllSessions, verifyPassword } from "@/lib/auth";
import { digestIdentity } from "@/lib/mfa";
import { consumeIdentityLink } from "@/lib/services/identity";
import { createBusiness, createCall, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
const enabled = hasTestDatabase();
function request(token: string, tenant?: string) { return new NextRequest("http://localhost/api/v1/auth/me", { headers: { Authorization: `Bearer ${token}`, ...(tenant ? { "x-tenant-id": tenant } : {}) } }); }
describe.skipIf(!enabled)("enterprise security against PostgreSQL", () => {
  beforeAll(async () => { await ensureDbReady(); await truncateAll(); });
  afterAll(async () => { await truncateAll(); await closeDb(); });
  itDb("serializes simultaneous refresh and commits reuse revocation", async () => {
    const business = await createBusiness(); const { user } = await createUser(business.id);
    const issued = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
    const results = await Promise.allSettled([rotateRefreshToken(issued.refreshToken), rotateRefreshToken(issued.refreshToken)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("TOKEN_REUSE_DETECTED");
    const active = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
    expect(active).toHaveLength(0);
    await expect(getAuthContext(request(issued.accessToken))).rejects.toMatchObject({ code: "TOKEN_REVOKED" });
  });
  itDb("revokes access immediately, rejects forged tenant headers and inactive tenants", async () => {
    const business = await createBusiness(); const other = await createBusiness(); const { user } = await createUser(business.id);
    const issued = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
    await expect(getAuthContext(request(issued.accessToken, other.id))).rejects.toMatchObject({ status: 403 });
    await revokeAllSessions(user.id);
    await expect(getAuthContext(request(issued.accessToken))).rejects.toMatchObject({ status: 401 });
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, business.id));
    await expect(issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" })).rejects.toMatchObject({ status: 403 });
  });
  itDb("database rejects a cross-tenant transcript even when services are bypassed", async () => {
    const a = await createBusiness(); const b = await createBusiness(); const call = await createCall(a.id);
    await expect(db.insert(callMessages).values({ businessId: b.id, callId: call.id, role: "CUSTOMER", content: "foreign" })).rejects.toThrow();
    await db.insert(callMessages).values({ businessId: a.id, callId: call.id, role: "CUSTOMER", content: "own" });
    const rows = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(rows).toHaveLength(1);
  });
  itDb("password reset is single-use and revokes existing sessions atomically", async () => {
    const business = await createBusiness(); const { user } = await createUser(business.id);
    const issued = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
    const raw = crypto.randomUUID();
    await db.insert(identityTokens).values({ businessId: business.id, userId: user.id, purpose: "password_reset", tokenHash: digestIdentity(raw), expiresAt: new Date(Date.now() + 60000) });
    await consumeIdentityLink(raw, "password_reset", "NewStrong456!");
    await expect(consumeIdentityLink(raw, "password_reset", "Another789!")).rejects.toMatchObject({ status: 400 });
    await expect(getAuthContext(request(issued.accessToken))).rejects.toMatchObject({ status: 401 });
    const [updated] = await db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword("NewStrong456!", updated.passwordHash)).toBe(true);
  });
});
