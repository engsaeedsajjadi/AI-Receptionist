import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { identityTokens, oauthAccounts, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { totp } from "@/lib/mfa";
import { getRedis } from "@/lib/redis";
import { resetEnvCache } from "@/lib/env";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * OAuth/OIDC HTTP surface.
 *
 * The identity provider itself is mocked (its live behaviour is covered by the
 * explicit live suite, `tests/live/oauth.acceptance.ts`) so these tests target
 * the logic that must never be wrong: state/cookie enforcement, tenant binding
 * of a linked identity, the MFA challenge path, conflict handling and the
 * cookies we hand back.
 */

const oidcState: { flow: unknown; fail?: Error } = { flow: undefined };

vi.mock("@/lib/oidc", async () => {
  const { AppError: Err } = await import("@/lib/errors");
  return {
    oauthProvider: (value: string) => {
      if (value !== "google" && value !== "microsoft") throw new Err(404, "NOT_FOUND", "OAuth provider not found");
      return value;
    },
    oauthCallbackUrl: (provider: string) => new URL(`http://localhost:3000/api/v1/auth/oauth/${provider}/callback`),
    oauthCookie: (value: string, maxAge = 600) =>
      `ar_oidc=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
    startOAuth: async (provider: string, account?: unknown) => {
      if (oidcState.fail) throw oidcState.fail;
      const state = account ? "state-linked" : "state-login";
      await (await import("@/lib/redis")).redisSet(`oauth:flow:${state}`, JSON.stringify({ provider, ...(account ?? {}) }), 60);
      return { url: `https://accounts.example.test/authorize?state=${state}&provider=${provider}`, cookie: `ar_oidc=${state}; HttpOnly` };
    },
    finishOAuth: async () => {
      if (oidcState.fail) throw oidcState.fail;
      return oidcState.flow;
    },
  };
});

function send(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; cookies?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "http://localhost:3000", ...init.headers };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.cookies) headers.Cookie = init.cookies;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const MFA_SECRET = "JBSWY3DPEHPK3PXP";

async function tenantUser(overrides: { mfaEnabled?: boolean; corruptSecret?: boolean } = {}) {
  const business = await createBusiness(`OAuth ${crypto.randomUUID().slice(0, 8)}`);
  const { user, password } = await createUser(business.id, "ADMIN");
  if (overrides.mfaEnabled) {
    const { encryptMfa } = await import("@/lib/mfa");
    await db
      .update(users)
      // The column holds an AES-GCM ciphertext bound to the user id, so the
      // fixture must encrypt like the application does.
      .set({ mfaEnabled: true, mfaSecret: overrides.corruptSecret ? "not-a-ciphertext" : encryptMfa(MFA_SECRET, user.id) })
      .where(eq(users.id, user.id));
  }
  const [row] = await db.select().from(users).where(eq(users.id, user.id));
  return { business, user: row, password };
}

describe.skipIf(!hasTestDatabase())("OAuth routes (HTTP)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "ff".repeat(32));
    vi.stubEnv("APP_URL", "http://localhost:3000");
    resetEnvCache();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    delete oidcState.fail;
    oidcState.flow = undefined;
    // The login rate-limit preset counts per IP; these tests intentionally
    // hammer the login surface, so start each case from a clean counter.
    await getRedis()?.flushall().catch(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  itDb("starts a sign-in flow and never accepts an unknown provider", async () => {
    const route = await import("@/app/api/v1/auth/oauth/[provider]/route");
    const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

    const unknown = await route.GET(send("/api/v1/auth/oauth/facebook"), params("facebook"));
    expect(unknown.status).toBe(404);

    const started = await route.GET(send("/api/v1/auth/oauth/google"), params("google"));
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toContain("https://accounts.example.test/authorize");
    expect(started.headers.get("set-cookie")).toContain("ar_oidc=");
  });

  itDb("requires an authenticated session and the correct password to link an identity", async () => {
    const route = await import("@/app/api/v1/auth/oauth/[provider]/route");
    const params = { params: Promise.resolve({ provider: "google" }) };

    const anonymous = await route.POST(send("/api/v1/auth/oauth/google", { body: { password: "Test1234!" } }), params);
    expect(anonymous.status).toBe(401);

    const { user, password } = await tenantUser();
    const { issueAuthTokens } = await import("@/lib/auth");
    const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role });

    const wrong = await route.POST(send("/api/v1/auth/oauth/google", { token: accessToken, body: { password: "definitely-wrong" } }), params);
    expect(wrong.status).toBe(401);
    expect((await wrong.json()) as { error: { code: string } }).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });

    const linked = await route.POST(send("/api/v1/auth/oauth/google", { token: accessToken, body: { password } }), params);
    expect(linked.status).toBe(200);
    const body = (await linked.json()) as { url: string };
    expect(body.url).toContain("state-linked");
    expect(linked.headers.get("set-cookie")).toContain("ar_oidc=");
  });

  itDb("refuses a callback without the state cookie and rejects a tampered state", async () => {
    const route = await import("@/app/api/v1/auth/oauth/[provider]/callback/route");
    const params = { params: Promise.resolve({ provider: "google" }) };

    oidcState.fail = new AppError(401, "UNAUTHORIZED", "OAuth state mismatch");
    const noCookie = await route.GET(send("/api/v1/auth/oauth/google/callback?code=x&state=forged"), params);
    expect(noCookie.status).toBe(401);
    expect((await noCookie.json()) as { error: { code: string } }).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    oidcState.fail = new AppError(401, "UNAUTHORIZED", "OAuth flow expired or consumed");
    const replayed = await route.GET(send("/api/v1/auth/oauth/google/callback?code=x&state=state-login", { cookies: "ar_oidc=state-login" }), params);
    expect(replayed.status).toBe(401);
  });

  itDb("logs in a linked identity and applies MFA when the user has it enabled", async () => {
    const route = await import("@/app/api/v1/auth/oauth/[provider]/callback/route");
    const params = { params: Promise.resolve({ provider: "google" }) };

    // 1 · Linked identity without MFA ⇒ session cookies, straight to the dashboard.
    const plain = await tenantUser();
    await db.insert(oauthAccounts).values({
      userId: plain.user.id,
      businessId: plain.business.id,
      provider: "google",
      subject: "sub-plain",
      issuer: "https://accounts.google.com",
    });
    oidcState.flow = { flow: { provider: "google" }, issuer: "https://accounts.google.com", subject: "sub-plain" };
    const loggedIn = await route.GET(send("/api/v1/auth/oauth/google/callback?code=x&state=state-login", { cookies: "ar_oidc=state-login" }), params);
    expect(loggedIn.status).toBe(302);
    expect(loggedIn.headers.get("location")).toBe("http://localhost:3000/dashboard");
    const cookies = loggedIn.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("ar_refresh") || c.includes("refresh"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("ar_oidc=;"))).toBe(true);

    // 2 · Linked identity with MFA ⇒ challenge ticket + no session yet.
    const hardened = await tenantUser({ mfaEnabled: true });
    await db.insert(oauthAccounts).values({
      userId: hardened.user.id,
      businessId: hardened.business.id,
      provider: "google",
      subject: "sub-mfa",
      issuer: "https://accounts.google.com",
    });
    oidcState.flow = { flow: { provider: "google" }, issuer: "https://accounts.google.com", subject: "sub-mfa" };
    const challenged = await route.GET(send("/api/v1/auth/oauth/google/callback?code=x&state=state-login", { cookies: "ar_oidc=state-login" }), params);
    expect(challenged.status).toBe(302);
    expect(challenged.headers.get("location")).toBe("http://localhost:3000/account/oauth");
    const challengeCookie = challenged.headers.getSetCookie().find((c) => c.startsWith("ar_oauth_mfa="));
    expect(challengeCookie).toBeTruthy();
    expect(challenged.headers.getSetCookie().some((c) => c.includes("ar_refresh") || c.includes("refresh"))).toBe(false);
    const challenge = decodeURIComponent(challengeCookie!.split("=")[1].split(";")[0]);
    const [ticket] = await db
      .select()
      .from(identityTokens)
      .where(and(eq(identityTokens.userId, hardened.user.id), eq(identityTokens.purpose, "oauth_mfa")));
    expect(ticket).toBeTruthy();
    if (getRedis()) {
      expect(await getRedis()!.get(`oauth:version:${(await import("@/lib/mfa")).digestIdentity(challenge)}`)).toBe(
        String(hardened.user.credentialVersion),
      );
    }
  });

  itDb("refuses unlinked identities and inactive users", async () => {
    const route = await import("@/app/api/v1/auth/oauth/[provider]/callback/route");
    const params = { params: Promise.resolve({ provider: "google" }) };

    const stranger = await tenantUser();
    oidcState.flow = { flow: { provider: "google" }, issuer: "https://accounts.google.com", subject: "sub-unknown" };
    const notLinked = await route.GET(
      send("/api/v1/auth/oauth/google/callback?code=x&state=state-login", { cookies: "ar_oidc=state-login" }),
      params,
    );
    expect(notLinked.status).toBe(403);
    expect((await notLinked.json()) as { error: { message: string } }).toMatchObject({
      error: { message: expect.stringContaining("Sign in with your password first") },
    });

    await db.insert(oauthAccounts).values({
      userId: stranger.user.id,
      businessId: stranger.business.id,
      provider: "google",
      subject: "sub-inactive",
      issuer: "https://accounts.google.com",
    });
    await db.update(users).set({ isActive: false }).where(eq(users.id, stranger.user.id));
    oidcState.flow = { flow: { provider: "google" }, issuer: "https://accounts.google.com", subject: "sub-inactive" };
    const inactive = await route.GET(
      send("/api/v1/auth/oauth/google/callback?code=x&state=state-login", { cookies: "ar_oidc=state-login" }),
      params,
    );
    expect(inactive.status).toBe(401);
  });

  itDb("links an identity from an authenticated flow and refuses conflicting links", async () => {
    const route = await import("@/app/api/v1/auth/oauth/[provider]/callback/route");
    const params = { params: Promise.resolve({ provider: "google" }) };
    const { user, business } = await tenantUser();

    oidcState.flow = {
      flow: { provider: "google", userId: user.id, businessId: business.id, credentialVersion: user.credentialVersion },
      issuer: "https://accounts.google.com",
      subject: "sub-link",
    };
    const linked = await route.GET(
      send("/api/v1/auth/oauth/google/callback?code=x&state=state-linked", { cookies: "ar_oidc=state-linked" }),
      params,
    );
    expect(linked.status).toBe(302);
    expect(linked.headers.get("location")).toBe("http://localhost:3000/dashboard/security");
    const [row] = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, user.id));
    expect(row).toMatchObject({ subject: "sub-link", provider: "google" });

    // Re-linking the same identity is idempotent.
    const again = await route.GET(
      send("/api/v1/auth/oauth/google/callback?code=x&state=state-linked", { cookies: "ar_oidc=state-linked" }),
      params,
    );
    expect(again.status).toBe(302);

    // A stale credential version must not silently link.
    oidcState.flow = {
      flow: { provider: "google", userId: user.id, businessId: business.id, credentialVersion: user.credentialVersion - 1 },
      issuer: "https://accounts.google.com",
      subject: "sub-stale",
    };
    const stale = await route.GET(
      send("/api/v1/auth/oauth/google/callback?code=x&state=state-linked", { cookies: "ar_oidc=state-linked" }),
      params,
    );
    expect(stale.status).toBe(401);

    // An identity already linked to somebody else is a conflict, not a takeover.
    const other = await tenantUser();
    await db.insert(oauthAccounts).values({
      userId: other.user.id,
      businessId: other.business.id,
      provider: "google",
      subject: "sub-taken",
      issuer: "https://accounts.google.com",
    });
    oidcState.flow = {
      flow: { provider: "google", userId: user.id, businessId: business.id, credentialVersion: user.credentialVersion },
      issuer: "https://accounts.google.com",
      subject: "sub-taken",
    };
    const conflict = await route.GET(
      send("/api/v1/auth/oauth/google/callback?code=x&state=state-linked", { cookies: "ar_oidc=state-linked" }),
      params,
    );
    expect(conflict.status).toBe(409);
  });

  itDb("completes the MFA challenge with a one-time ticket and rejects replays", async () => {
    const complete = await import("@/app/api/v1/auth/oauth/complete/route");
    const { digestIdentity } = await import("@/lib/mfa");
    const { user } = await tenantUser({ mfaEnabled: true });

    // Origin is mandatory (CSRF protection), and it must match APP_URL.
    const noOrigin = await complete.POST(send("/api/v1/auth/oauth/complete", { headers: { Origin: "" }, body: { code: "123456" } }));
    expect(noOrigin.status).toBe(403);

    const { issueAuthTokens } = await import("@/lib/auth");
    void issueAuthTokens;

    const withoutChallenge = await complete.POST(send("/api/v1/auth/oauth/complete", { body: { code: "123456" } }));
    expect(withoutChallenge.status).toBe(401);

    const challenge = "challenge-token-for-tests";
    await db.insert(identityTokens).values({
      businessId: user.businessId,
      userId: user.id,
      purpose: "oauth_mfa",
      tokenHash: digestIdentity(challenge),
      expiresAt: new Date(Date.now() + 300_000),
    });

    // Without the Redis version key the challenge is considered expired.
    const noVersion = await complete.POST(
      send("/api/v1/auth/oauth/complete", { body: { code: totp(MFA_SECRET) }, cookies: `ar_oauth_mfa=${challenge}` }),
    );
    expect(noVersion.status).toBe(401);
    expect((await noVersion.json()) as { error: { message: string } }).toMatchObject({
      error: { message: expect.stringContaining("expired") },
    });

    const redis = getRedis();
    if (!redis) return; // The tracked path needs Redis; CI and local both provide it.
    await redis.set(`oauth:version:${digestIdentity(challenge)}`, String(user.credentialVersion), "EX", 300);

    const wrongCode = await complete.POST(
      send("/api/v1/auth/oauth/complete", { body: { code: "000000" }, cookies: `ar_oauth_mfa=${challenge}` }),
    );
    expect(wrongCode.status).toBe(401);

    const succeeded = await complete.POST(
      send("/api/v1/auth/oauth/complete", { body: { code: totp(MFA_SECRET) }, cookies: `ar_oauth_mfa=${challenge}` }),
    );
    expect(succeeded.status).toBe(200);
    expect((await succeeded.json()) as { ok: boolean }).toMatchObject({ ok: true });
    const setCookies = succeeded.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("ar_oauth_mfa=;"))).toBe(true);
    expect(setCookies.some((c) => c.includes("refresh"))).toBe(true);

    const [consumed] = await db
      .select()
      .from(identityTokens)
      .where(and(eq(identityTokens.tokenHash, digestIdentity(challenge)), eq(identityTokens.purpose, "oauth_mfa")));
    expect(consumed.consumedAt).toBeTruthy();
    expect(await redis.get(`oauth:version:${digestIdentity(challenge)}`)).toBeNull();

    // Replaying the same challenge must fail.
    const replay = await complete.POST(
      send("/api/v1/auth/oauth/complete", { body: { code: totp(MFA_SECRET) }, cookies: `ar_oauth_mfa=${challenge}` }),
    );
    expect(replay.status).toBe(401);
  });

  itDb("denies login (401, never 500) when the stored MFA secret is unusable", async () => {
    const complete = await import("@/app/api/v1/auth/oauth/complete/route");
    const { digestIdentity } = await import("@/lib/mfa");
    const { user } = await tenantUser({ mfaEnabled: true, corruptSecret: true });
    const challenge = `corrupt-${crypto.randomUUID()}`;
    await db.insert(identityTokens).values({
      businessId: user.businessId,
      userId: user.id,
      purpose: "oauth_mfa",
      tokenHash: digestIdentity(challenge),
      expiresAt: new Date(Date.now() + 300_000),
    });
    const redis = getRedis();
    if (!redis) return;
    await redis.set(`oauth:version:${digestIdentity(challenge)}`, String(user.credentialVersion), "EX", 300);

    const res = await complete.POST(
      send("/api/v1/auth/oauth/complete", { body: { code: "123456" }, cookies: `ar_oauth_mfa=${challenge}` }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
  });

  itDb("validates the MFA completion payload before touching any state", async () => {
    const complete = await import("@/app/api/v1/auth/oauth/complete/route");
    const malformed = await complete.POST(
      send("/api/v1/auth/oauth/complete", { body: { code: "12" }, cookies: "ar_oauth_mfa=challenge-token-for-tests" }),
    );
    expect(malformed.status).toBe(400);
  });
});
