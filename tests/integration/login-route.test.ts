import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { verifyAccessToken } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * `POST /api/v1/auth/login` over HTTP: the session a browser or API client
 * actually receives, the uniform failure that prevents account enumeration and
 * the lockout that stops password guessing.
 */
function login(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function clearRateLimits() {
  const redis = getRedis();
  if (!redis) return;
  const keys = await redis.keys("rl:*").catch(() => [] as string[]);
  if (keys.length) await redis.del(keys).catch(() => undefined);
}

async function account() {
  const business = await createBusiness();
  const { user, password } = await createUser(business.id, "ADMIN");
  return { business, user, password };
}

describe.skipIf(!hasTestDatabase())("login route", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await clearRateLimits();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    await clearRateLimits();
  });

  itDb("signs in with a tenant-scoped access token and an HttpOnly refresh cookie", async () => {
    const { business, user, password } = await account();
    const { POST } = await import("@/app/api/v1/auth/login/route");

    const res = await POST(login({ email: user.email.toUpperCase(), password }, { "user-agent": "vitest-browser" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);

    expect(body.user).toEqual({
      id: user.id, businessId: business.id, name: user.name, email: user.email, role: "ADMIN",
    });
    expect(text).not.toContain(user.passwordHash);
    expect(text).not.toContain("passwordHash");

    const claims = await verifyAccessToken(body.accessToken);
    expect(claims).toMatchObject({ sub: user.id, businessId: business.id, role: "ADMIN" });

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(encodeURIComponent(body.refreshToken));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");

    const sessions = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).toBeNull();

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.failedLoginCount).toBe(0);
    expect(after.lastLoginAt).toBeInstanceOf(Date);
  });

  itDb("answers wrong password, unknown e-mail and disabled account identically", async () => {
    const { user, password } = await account();
    const disabled = await account();
    await db.update(users).set({ isActive: false }).where(eq(users.id, disabled.user.id));
    const { POST } = await import("@/app/api/v1/auth/login/route");

    const outcomes = [];
    for (const attempt of [
      { email: user.email, password: "definitely-wrong" },
      { email: "nobody@example.com", password },
      { email: disabled.user.email, password: disabled.password },
    ]) {
      const res = await POST(login(attempt));
      const body = await res.json();
      expect(res.headers.get("Set-Cookie")).toBeNull();
      outcomes.push({ status: res.status, code: body.error.code, message: body.error.message });
    }
    expect(outcomes).toEqual(Array(3).fill({ status: 401, code: "INVALID_CREDENTIALS", message: "Invalid credentials" }));

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.failedLoginCount).toBe(1);
    expect(await db.select().from(refreshTokens)).toHaveLength(0);
  });

  itDb("rejects malformed bodies before looking anything up", async () => {
    const { user } = await account();
    const { POST } = await import("@/app/api/v1/auth/login/route");

    for (const body of [{}, { email: "not-an-email", password: "x" }, { email: user.email, password: "" }, "{not json"]) {
      const res = await POST(login(body));
      expect(res.status).toBe(400);
    }
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.failedLoginCount).toBe(0);
  });

  itDb("locks the account after ten failures and refuses even the correct password", async () => {
    const { user, password } = await account();
    const { POST } = await import("@/app/api/v1/auth/login/route");

    for (let attempt = 0; attempt < 10; attempt++) {
      await clearRateLimits(); // isolate the account lockout from the per-IP limiter
      const res = await POST(login({ email: user.email, password: `wrong-${attempt}` }));
      expect(res.status).toBe(401);
    }
    const [locked] = await db.select().from(users).where(eq(users.id, user.id));
    expect(locked.failedLoginCount).toBe(10);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    await clearRateLimits();
    const res = await POST(login({ email: user.email, password }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await db.select().from(refreshTokens)).toHaveLength(0);
  });

  itDb("a successful login clears earlier failures", async () => {
    const { user, password } = await account();
    const { POST } = await import("@/app/api/v1/auth/login/route");

    for (let attempt = 0; attempt < 3; attempt++) {
      await POST(login({ email: user.email, password: "wrong" }));
    }
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].failedLoginCount).toBe(3);

    await clearRateLimits();
    expect((await POST(login({ email: user.email, password }))).status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  itDb("throttles repeated attempts from one client", async () => {
    const { user } = await account();
    const { POST } = await import("@/app/api/v1/auth/login/route");
    if (!getRedis()) return; // the limiter is Redis-backed

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      statuses.push((await POST(login({ email: user.email, password: "wrong" }))).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Throttled requests never reach the password check.
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].failedLoginCount).toBe(5);
  });
});
