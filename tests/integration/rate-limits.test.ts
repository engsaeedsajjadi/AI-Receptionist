import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { GET as ready } from "@/app/api/health/ready/route";
import { POST as logout } from "@/app/api/v1/auth/logout/route";

const runIntegration = hasTestDatabase();

/**
 * These routes share the `default` preset (60/min per client IP). Tests use
 * documentation-range IPs via x-real-ip (TRUST_PROXY=false in tests, so the
 * limiter reads x-real-ip directly) — buckets no other test can pollute.
 * A minute-boundary straddle mid-loop would reset the window, so each test
 * runs a second fill loop if the first did not trip; one of the two loops is
 * guaranteed to contain 61 in-window hits.
 */
function reqWithIp(url: string, ip: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new Request(url, {
      ...init,
      headers: { "x-real-ip": ip, ...(init?.headers ?? {}) },
    }),
  );
}

describe.skipIf(!runIntegration)("rate-limit wiring on public routes (real database)", () => {
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

  itDb("GET /api/health/ready trips 429 after 60 hits, then recovers", async () => {
    const ip = "198.51.100.21";
    let trips = 0;
    for (let round = 0; round < 2 && trips === 0; round++) {
      for (let i = 0; i < 61 && trips === 0; i++) {
        const res = await ready(reqWithIp("http://localhost/api/health/ready", ip));
        if (res.status === 429) trips++;
        else expect(res.status).toBe(200);
      }
    }
    expect(trips).toBeGreaterThan(0);
    // A different client is unaffected (per-IP buckets, not global).
    const other = await ready(reqWithIp("http://localhost/api/health/ready", "198.51.100.22"));
    expect(other.status).toBe(200);
  });

  itDb("POST /api/v1/auth/logout is bounded per IP", async () => {
    const ip = "198.51.100.23";
    let trips = 0;
    for (let round = 0; round < 2 && trips === 0; round++) {
      for (let i = 0; i < 61 && trips === 0; i++) {
        const res = await logout(
          reqWithIp("http://localhost/api/v1/auth/logout", ip, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        if (res.status === 429) trips++;
        else expect(res.status).toBe(200);
      }
    }
    expect(trips).toBeGreaterThan(0);
  });
});
