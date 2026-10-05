import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { leads } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { GET as leadsGet } from "@/app/api/v1/leads/route";
import { GET as usersGet } from "@/app/api/v1/users/route";
import { GET as usageGet } from "@/app/api/v1/usage/route";
import { GET as notificationsGet } from "@/app/api/v1/notifications/route";
import { createBusiness, createCustomer, createLead, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Keyset cursor pagination over the tenant list endpoints.
 *
 * The guarantees that matter: page boundaries are stable (a full walk visits
 * every row exactly once, even when many rows share a `created_at`), a cursor is
 * never a way around the tenant predicate, malformed cursors are a 400, and the
 * legacy offset window keeps working for existing clients.
 */

let ipSeq = 0;
function list(path: string, token: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      // One client IP per request so the shared limiter window is not the thing under test.
      "x-real-ip": `10.7.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
    },
  });
}

type Page<T> = { data: T[]; nextCursor: string | null; hasMore: boolean; pagination: { page: number; limit: number; total?: number; totalPages?: number } };

async function tenantWithLeads(count: number) {
  const business = await createBusiness(`Cursor ${crypto.randomUUID().slice(0, 8)}`);
  const { user } = await createUser(business.id, "ADMIN");
  const customer = await createCustomer(business.id, `0912${String(Date.now()).slice(-7)}`);
  const created: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const lead = await createLead(business.id, customer.id);
    created.push(lead.id);
  }
  const tokens = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
  return { business, user, token: tokens.accessToken, created };
}

describe.skipIf(!hasTestDatabase())("cursor pagination (HTTP)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("walks every row exactly once across pages and reports honest boundaries", async () => {
    const a = await tenantWithLeads(7);

    const first = (await (await leadsGet(list("/api/v1/leads?limit=3", a.token))).json()) as Page<{ id: string }>;
    expect(first.data).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    // Legacy clients keep the exact total and page metadata.
    expect(first.pagination).toMatchObject({ page: 1, limit: 3, total: 7, totalPages: 3 });

    const seen = [...first.data.map((row) => row.id)];
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = (await (await leadsGet(list(`/api/v1/leads?limit=3&cursor=${encodeURIComponent(cursor)}`, a.token))).json()) as Page<{ id: string }>;
      pages += 1;
      seen.push(...page.data.map((row) => row.id));
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor did not terminate");
    }

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...a.created].sort());
  });

  itDb("walks rows that share a millisecond but differ below it", async () => {
    const a = await tenantWithLeads(7);
    // Seven rows inside a single millisecond — the cursor can only carry
    // milliseconds while Postgres stores microseconds, so a cursor compared
    // against the full-precision column silently drops every later row in that
    // millisecond. The ordering and the cursor must agree on the same precision.
    for (const [i, id] of a.created.entries()) {
      await db.execute(sql`update leads set created_at = ${`2026-02-03 04:05:06.12000${i}`}::timestamptz where id = ${id}::uuid`);
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const body = (await (await leadsGet(list(`/api/v1/leads?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, a.token))).json()) as Page<{ id: string }>;
      for (const row of body.data) seen.add(row.id);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(7);
  });

  itDb("is stable when many rows share one created_at (id tiebreak)", async () => {
    const a = await tenantWithLeads(5);
    // Same instant for every row: a created_at-only cursor would loop or skip.
    const stamp = new Date("2026-02-03T04:05:06.000Z");
    await db.update(leads).set({ createdAt: stamp }).where(eq(leads.businessId, a.business.id));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const query: string = cursor
        ? `/api/v1/leads?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/leads?limit=2";
      const page: Page<{ id: string }> = (await (await leadsGet(list(query, a.token))).json()) as Page<{ id: string }>;
      seen.push(...page.data.map((row: { id: string }) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  itDb("never lets a cursor cross the tenant boundary, and rejects garbage", async () => {
    const a = await tenantWithLeads(4);
    const b = await tenantWithLeads(3);
    // B's rows are older than A's cursor, so the cursor genuinely narrows B's own
    // result set — the tenant predicate is what stops it leaking A's rows.
    await db.update(leads).set({ createdAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(leads.businessId, b.business.id));

    const aPage = (await (await leadsGet(list("/api/v1/leads?limit=2", a.token))).json()) as Page<{ id: string }>;
    expect(aPage.nextCursor).toBeTruthy();

    // Tenant B replays tenant A's cursor: no A row may appear.
    const bPage = (await (
      await leadsGet(list(`/api/v1/leads?limit=2&cursor=${encodeURIComponent(aPage.nextCursor as string)}`, b.token))
    ).json()) as Page<{ id: string }>;
    const aIds = new Set(a.created);
    for (const row of bPage.data) expect(aIds.has(row.id)).toBe(false);
    // B still sees its own three rows (older than the borrowed cursor).
    expect(bPage.pagination).toMatchObject({ total: 3 });

    const malformed = await leadsGet(list("/api/v1/leads?cursor=not-a-cursor", a.token));
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  itDb("keeps the legacy offset window working alongside cursors", async () => {
    const a = await tenantWithLeads(5);

    const page2 = (await (await leadsGet(list("/api/v1/leads?page=2&limit=2", a.token))).json()) as Page<{ id: string }>;
    expect(page2.pagination).toMatchObject({ page: 2, total: 5, totalPages: 3 });
    expect(page2.hasMore).toBe(true);
    expect(page2.nextCursor).toBeTruthy();

    const page3 = (await (await leadsGet(list("/api/v1/leads?page=3&limit=2", a.token))).json()) as Page<{ id: string }>;
    expect(page3.data).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  itDb("applies to the other tenant list endpoints with exact totals", async () => {
    const a = await tenantWithLeads(3);

    const users = (await (await usersGet(list("/api/v1/users?limit=1", a.token))).json()) as Page<{ id: string }>;
    expect(users.data).toHaveLength(1);
    expect(users.pagination.total).toBe(1);
    expect(users.hasMore).toBe(false);

    const usage = (await (await usageGet(list("/api/v1/usage?limit=1", a.token))).json()) as Page<{ id: string }> & { totals: unknown[] };
    expect(usage.pagination.total).toBe(0);
    expect(usage.hasMore).toBe(false);
    expect(Array.isArray(usage.totals)).toBe(true);

    const notifications = (await (await notificationsGet(list("/api/v1/notifications?limit=1", a.token))).json()) as Page<{ id: string }>;
    expect(notifications.pagination.total).toBe(0);
    expect(notifications.nextCursor).toBeNull();

    // Cursors are accepted on every migrated endpoint: a cursor minted from one
    // list narrows that list too (here: nothing newer than the newest lead).
    const leadPage = (await (await leadsGet(list("/api/v1/leads?limit=1", a.token))).json()) as Page<{ id: string }>;
    expect(leadPage.nextCursor).toBeTruthy();
    const notificationsWithCursor = (await (
      await notificationsGet(list(`/api/v1/notifications?limit=1&cursor=${encodeURIComponent(leadPage.nextCursor as string)}`, a.token))
    ).json()) as Page<{ id: string }>;
    expect(notificationsWithCursor.data).toHaveLength(0);
    expect(notificationsWithCursor.hasMore).toBe(false);
  });
});
