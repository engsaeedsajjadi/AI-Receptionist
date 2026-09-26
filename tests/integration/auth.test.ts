import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { uniqueTestIp } from "../helpers/http";

const runIntegration = hasTestDatabase();

function req(url: string, body: unknown, ip: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(new Request(url, {
    method: "POST",
    // TRUST_PROXY=false in tests, so the limiter reads x-real-ip (NOT
    // x-forwarded-for). Default to a unique bucket; explicit headers win.
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, "x-real-ip": uniqueTestIp(), ...(headers ?? {}) },
    body: JSON.stringify(body),
  }));
}

describe.skipIf(!runIntegration)("auth lifecycle (real database)", () => {
  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("registers, logs in, and reads /me", async () => {
    const { POST: register } = await import("@/app/api/v1/auth/register/route");
    const res = await register(
      req("http://localhost/api/v1/auth/register", {
        businessName: "Auth Biz",
        businessSlug: `auth-biz-${Date.now()}`,
        name: "Auth Admin",
        email: `auth-${Date.now()}@example.com`,
        password: "Strong123!",
      }, "10.0.0.1"),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    const { GET: me } = await import("@/app/api/v1/auth/me/route");
    const meRes = await me(
      new NextRequest(new Request("http://localhost/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${body.accessToken}`, "x-forwarded-for": "10.0.0.2" },
      })),
    );
    expect(meRes.status).toBe(200);
  });

  itDb("rejects weak passwords", async () => {
    const { POST: register } = await import("@/app/api/v1/auth/register/route");
    const res = await register(
      req("http://localhost/api/v1/auth/register", {
        businessName: "Weak Biz",
        businessSlug: `weak-biz-${Date.now()}`,
        name: "Weak",
        email: `weak-${Date.now()}@example.com`,
        password: "short",
      }, "10.0.0.3"),
    );
    expect(res.status).toBe(400);
  });

  itDb("rotates refresh tokens and detects reuse", async () => {
    const { POST: register } = await import("@/app/api/v1/auth/register/route");
    const { POST: refresh } = await import("@/app/api/v1/auth/refresh/route");
    const email = `rot-${Date.now()}@example.com`;
    const reg = await register(
      req("http://localhost/api/v1/auth/register", {
        businessName: "Rot Biz",
        businessSlug: `rot-biz-${Date.now()}`,
        name: "Rot",
        email,
        password: "Strong123!",
      }, "10.0.0.4"),
    );
    const { refreshToken } = (await reg.json()) as { refreshToken: string };

    const first = await refresh(req("http://localhost/api/v1/auth/refresh", { refreshToken }, "10.0.0.5"));
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { refreshToken: string };
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // Reusing the old token → reuse detected.
    const reuse = await refresh(req("http://localhost/api/v1/auth/refresh", { refreshToken }, "10.0.0.6"));
    expect(reuse.status).toBe(401);
    const reuseBody = (await reuse.json()) as { error: { code: string } };
    expect(reuseBody.error.code).toBe("TOKEN_REUSE_DETECTED");

    // The rotated token was revoked as part of the family → also rejected.
    const after = await refresh(
      req("http://localhost/api/v1/auth/refresh", { refreshToken: rotated.refreshToken }, "10.0.0.7"),
    );
    expect(after.status).toBe(401);
  });

  itDb("logs out a single session", async () => {
    const { POST: register } = await import("@/app/api/v1/auth/register/route");
    const { POST: logout } = await import("@/app/api/v1/auth/logout/route");
    const { POST: refresh } = await import("@/app/api/v1/auth/refresh/route");
    const email = `out-${Date.now()}@example.com`;
    const reg = await register(
      req("http://localhost/api/v1/auth/register", {
        businessName: "Out Biz",
        businessSlug: `out-biz-${Date.now()}`,
        name: "Out",
        email,
        password: "Strong123!",
      }, "10.0.0.8"),
    );
    const { refreshToken } = (await reg.json()) as { refreshToken: string };
    const out = await logout(req("http://localhost/api/v1/auth/logout", { refreshToken }, "10.0.0.9"));
    expect(out.status).toBe(200);

    const again = await refresh(req("http://localhost/api/v1/auth/refresh", { refreshToken }, "10.0.0.10"));
    expect(again.status).toBe(401);
  });

  itDb("locks accounts after repeated failures", async () => {
    const { POST: register } = await import("@/app/api/v1/auth/register/route");
    const { POST: login } = await import("@/app/api/v1/auth/login/route");
    const email = `lock-${Date.now()}@example.com`;
    await register(
      req("http://localhost/api/v1/auth/register", {
        businessName: "Lock Biz",
        businessSlug: `lock-biz-${Date.now()}`,
        name: "Lock",
        email,
        password: "Strong123!",
      }, "10.0.0.11"),
    );
    // Distinct x-real-ip per attempt (the limiter reads x-real-ip when
    // TRUST_PROXY=false): this simulates a distributed attack so every
    // attempt reaches the handler. Sharing one bucket would 429 at the rate
    // limiter after 5 hits and never exercise the lockout itself.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await login(
        req("http://localhost/api/v1/auth/login", { email, password: "Wrong123!" }, `10.0.1.${i}`, {
          "x-real-ip": `203.0.113.${20 + i}`,
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(401));
    expect(statuses[10]).toBe(429);
    const locked = await login(
      req("http://localhost/api/v1/auth/login", { email, password: "Strong123!" }, "10.0.1.99", {
        "x-real-ip": "203.0.113.31",
      }),
    );
    expect(locked.status).toBe(429);
    const payload = (await locked.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("locked");
    // Mechanism proof: the counter advanced and lockedUntil is set.
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(user.failedLoginCount).toBeGreaterThanOrEqual(10);
    expect(user.lockedUntil).not.toBeNull();
  });

  itDb("concurrent duplicate registrations collapse to one 201 + one 409 (never 500)", async () => {
    const { POST: register } = await import("@/app/api/v1/auth/register/route");
    const stamp = Date.now();
    const body = {
      businessName: "Race Biz",
      businessSlug: `race-biz-${stamp}`,
      name: "Race",
      email: `race-${stamp}@example.com`,
      password: "Strong123!",
    };
    // Fresh shared bucket (2 hits, limit 5): both attempts race for real.
    const ip = { "x-real-ip": "203.0.113.40" };
    const [a, b] = await Promise.all([
      register(req("http://localhost/api/v1/auth/register", body, "10.9.9.1", ip)),
      register(req("http://localhost/api/v1/auth/register", body, "10.9.9.2", ip)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    const payload = (await loser.json()) as { error: { code: string } };
    // Interleave-dependent: full-winner-first loses on the email pre-check,
    // mid-flight overlap loses on the slug unique index. Either way 409.
    expect(["EMAIL_EXISTS", "SLUG_EXISTS"]).toContain(payload.error.code);
  });
});
