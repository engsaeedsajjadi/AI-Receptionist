import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const runIntegration = hasTestDatabase();

function req(url: string, body: unknown, ip: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...(headers ?? {}) },
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
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await login(
        req("http://localhost/api/v1/auth/login", { email, password: "Wrong123!" }, `10.0.1.${i}`),
      );
      lastStatus = res.status;
    }
    // 429 with lockout message (rate-limit code doubles as lockout signal).
    expect(lastStatus).toBe(429);
  });
});
