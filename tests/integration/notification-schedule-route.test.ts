import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { outboxEvents } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Scheduled notifications (`/api/v1/notifications/schedule`): a delayed outbox
 * event. The contract is the time window, the recipient rule for external
 * channels, idempotent re-submission and strict tenant scoping.
 */
function request(token: string | undefined, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest("http://localhost/api/v1/notifications/schedule", {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function identity() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
  return { business, user, token: accessToken };
}

const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;

describe.skipIf(!hasTestDatabase())("scheduled notification route", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  itDb("requires authentication", async () => {
    const { GET, POST } = await import("@/app/api/v1/notifications/schedule/route");
    expect((await GET(request(undefined))).status).toBe(401);
    expect((await POST(request(undefined, { scheduledAt: inFuture(HOUR), title: "t", message: "m" }))).status).toBe(401);
  });

  itDb("rejects times outside the allowed window, unknown fields and missing recipients", async () => {
    const a = await identity();
    const { POST } = await import("@/app/api/v1/notifications/schedule/route");
    const base = { title: "یادآوری", message: "جلسه فردا" };

    const past = await POST(request(a.token, { ...base, scheduledAt: inFuture(-HOUR) }));
    expect(past.status).toBe(400);

    const tooSoon = await POST(request(a.token, { ...base, scheduledAt: inFuture(1_000) }));
    expect(tooSoon.status).toBe(400);

    const tooFar = await POST(request(a.token, { ...base, scheduledAt: inFuture(366 * 24 * HOUR) }));
    expect(tooFar.status).toBe(400);

    const noRecipient = await POST(request(a.token, { ...base, scheduledAt: inFuture(HOUR), channel: "sms" }));
    expect(noRecipient.status).toBe(400);
    expect((await noRecipient.json()).error.message).toMatch(/recipient/);

    const unknownField = await POST(request(a.token, { ...base, scheduledAt: inFuture(HOUR), businessId: a.business.id }));
    expect(unknownField.status).toBe(400);

    const notADate = await POST(request(a.token, { ...base, scheduledAt: "tomorrow" }));
    expect(notADate.status).toBe(400);

    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  itDb("stores a delayed outbox event and treats a repeated idempotency key as a duplicate", async () => {
    const a = await identity();
    const { POST } = await import("@/app/api/v1/notifications/schedule/route");
    const scheduledAt = inFuture(2 * HOUR);
    const payload = {
      scheduledAt, title: "یادآوری بازدید", message: "بازدید ملک ساعت ۱۰", channel: "sms",
      recipient: "09121112233", userId: a.user.id, idempotencyKey: "visit-reminder-001",
    };

    const first = await POST(request(a.token, payload));
    expect(first.status).toBe(201);
    const created = (await first.json());
    expect(created.duplicate).toBe(false);
    expect(created.scheduledAt).toBe(new Date(scheduledAt).toISOString());

    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, created.id));
    expect(row.topic).toBe("notification.requested");
    expect(row.businessId).toBe(a.business.id);
    expect(row.availableAt.toISOString()).toBe(new Date(scheduledAt).toISOString());
    expect(row.payload).toMatchObject({
      businessId: a.business.id, userId: a.user.id, channel: "sms", recipient: "09121112233", type: "scheduled",
    });

    const second = await POST(request(a.token, payload));
    expect(second.status).toBe(200);
    expect((await second.json())).toMatchObject({ id: null, duplicate: true });
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  itDb("refuses to target a user from another tenant", async () => {
    const a = await identity();
    const b = await identity();
    const { POST } = await import("@/app/api/v1/notifications/schedule/route");
    const res = await POST(request(a.token, {
      scheduledAt: inFuture(HOUR), title: "t", message: "m", userId: b.user.id,
    }));
    expect(res.status).toBe(404);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  itDb("lists only the caller's own pending scheduled notifications", async () => {
    const a = await identity();
    const b = await identity();
    const { GET, POST } = await import("@/app/api/v1/notifications/schedule/route");
    await POST(request(a.token, { scheduledAt: inFuture(HOUR), title: "الف", message: "پیام الف" }));
    await POST(request(a.token, { scheduledAt: inFuture(3 * HOUR), title: "ب", message: "پیام ب" }));
    await POST(request(b.token, { scheduledAt: inFuture(HOUR), title: "دیگری", message: "پیام مستاجر دیگر" }));

    const res = await GET(request(a.token));
    expect(res.status).toBe(200);
    const { scheduled } = (await res.json());
    // Latest first, and nothing from tenant B.
    expect(scheduled.map((s: { payload: { title: string } }) => s.payload.title)).toEqual(["ب", "الف"]);
  });
});
