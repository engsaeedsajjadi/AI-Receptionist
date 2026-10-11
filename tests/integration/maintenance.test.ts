import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { calls, notifications, refreshTokens } from "@/db/schema";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness, createUser } from "../helpers/fixtures";
import { POST as maintenance } from "@/app/api/v1/admin/maintenance/route";

const runIntegration = hasTestDatabase();
let ipOctet = 60;

function req(token: string | null, body: unknown = {}): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/v1/admin/maintenance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-real-ip": `198.51.100.${ipOctet++}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(!runIntegration)("maintenance sweep (real database)", () => {
  let adminToken = "";
  let agentToken = "";
  let stuckCallId = "";
  let staleNotifId = "";

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    const { issueAuthTokens } = await import("@/lib/auth");
    const biz = await createBusiness("Maint Biz");
    const admin = (await createUser(biz.id, "ADMIN")).user;
    const agent = (await createUser(biz.id, "AGENT")).user;
    adminToken = (await issueAuthTokens({ userId: admin.id, businessId: biz.id, role: "ADMIN" })).accessToken;
    agentToken = (await issueAuthTokens({ userId: agent.id, businessId: biz.id, role: "AGENT" })).accessToken;

    const hourAgo = new Date(Date.now() - 3600_000);
    const [call] = await db
      .insert(calls)
      .values({
        businessId: biz.id,
        externalCallId: `maint-${Date.now()}`,
        phoneNumber: "09123456789",
        status: "TRANSFERRING",
        transferRequestedAt: hourAgo,
      })
      .returning();
    stuckCallId = call.id;
    const [notif] = await db
      .insert(notifications)
      .values({
        businessId: biz.id,
        type: "test",
        channel: "email",
        title: "Stuck",
        message: "M",
        status: "PENDING",
        createdAt: hourAgo,
      })
      .returning();
    staleNotifId = notif.id;
    await db.insert(refreshTokens).values({
      userId: agent.id,
      businessId: biz.id,
      jti: randomUUID(),
      tokenHash: "expired-test-hash",
      expiresAt: new Date(Date.now() - 8 * 86400_000),
    });
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("rejects unauthenticated and non-ADMIN callers", async () => {
    expect((await maintenance(req(null))).status).toBe(401);
    const forbidden = await maintenance(req(agentToken));
    expect(forbidden.status).toBe(403);
  });

  itDb("ADMIN sweep reaps stuck rows and prunes expired tokens", async () => {
    const res = await maintenance(req(adminToken));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ reapedTransfers: 1, reapedNotifications: 1, prunedTokens: 1 });
    // The sweep also drives the outbox, outbound webhooks and export retention.
    expect(body.outbox).toMatchObject({ processed: expect.any(Number), delivered: expect.any(Number), dead: expect.any(Number) });
    expect(body.webhooks).toMatchObject({ attempted: expect.any(Number), delivered: expect.any(Number) });
    expect(body.purgedExports).toEqual(expect.any(Number));

    const [call] = await db.select().from(calls).where(eq(calls.id, stuckCallId)).limit(1);
    expect(call.status).toBe("TRANSFER_FAILED");
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, staleNotifId)).limit(1);
    expect(notif.status).toBe("FAILED");
    expect(notif.errorMessage).toBe("delivery_unconfirmed");
  });

  itDb("second sweep is a no-op (idempotent)", async () => {
    const res = await maintenance(req(adminToken));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ reapedTransfers: 0, reapedNotifications: 0, prunedTokens: 0 });
    expect(body.webhooks.attempted).toBe(0);
    expect(body.purgedExports).toBe(0);
  });
});
