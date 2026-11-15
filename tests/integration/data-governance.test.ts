import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { auditLogs, businesses, calls, dataExports, outboxEvents, users } from "@/db/schema";
import {
  applyRetentionPolicy,
  assertTransition,
  cancelTenantDeletion,
  dataExportDownload,
  listDataExports,
  processDataExport,
  purgeTenant,
  requestDataExport,
  requestTenantDeletion,
  retentionPolicy,
  setRetentionPolicy,
  tenantsDueForPurge,
  TENANT_STATES,
} from "@/lib/services/data-governance";
import { createBusiness, createCustomer, createLead, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

async function tenant(role: "ADMIN" | "AGENT" = "ADMIN") {
  const business = await createBusiness();
  const { user } = await createUser(business.id, role);
  return { business, user };
}

async function platformAdmin() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  return { business, user };
}

describe.skipIf(!hasTestDatabase())("tenant data export", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("LOCAL_STORAGE_DIR", "/tmp/ai-receptionist-test-storage");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  itDb("produces a tenant-scoped, compressed archive and records the ledger + outbox", async () => {
    const a = await tenant();
    const b = await tenant();
    const customerA = await createCustomer(a.business.id, "09121110000");
    await createLead(a.business.id, customerA.id);
    const customerB = await createCustomer(b.business.id, "09122220000");
    await createLead(b.business.id, customerB.id);

    const requested = await requestDataExport({ userId: a.user.id, businessId: a.business.id }, { scope: ["customers", "leads"] });
    expect(requested.status).toBe("PENDING");
    const result = await processDataExport(requested.id);
    expect(result.status).toBe("READY");
    expect(result.bytes).toBeGreaterThan(0);

    const [row] = await db.select().from(dataExports).where(eq(dataExports.id, requested.id));
    expect(row.status).toBe("READY");
    expect(row.storageKey).toContain(`business/${a.business.id}/exports/`);
    expect(row.rowCounts).toEqual({ customers: 1, leads: 1 });

    // The archive itself contains only this tenant's rows.
    const { getStorageProvider } = await import("@/lib/providers/storage");
    const { gunzipSync } = await import("node:zlib");
    const raw = gunzipSync(await getStorageProvider().download(row.storageKey!)).toString("utf8");
    expect(raw).toContain("09121110000");
    expect(raw).not.toContain("09122220000");

    // Storage metering and the export.ready event were recorded.
    const { storageObjects } = await import("@/db/schema");
    const objects = await db.select().from(storageObjects).where(eq(storageObjects.businessId, a.business.id));
    expect(objects).toHaveLength(1);
    expect(objects[0].category).toBe("export");
    const outbox = await db.select().from(outboxEvents).where(and(eq(outboxEvents.businessId, a.business.id), eq(outboxEvents.topic, "export.ready")));
    expect(outbox).toHaveLength(1);

    // A second processing pass is a no-op (the export was already claimed).
    expect(await processDataExport(requested.id)).toMatchObject({ skipped: true });

    // Download URL is tenant-scoped and refuses a foreign tenant.
    const download = await dataExportDownload(a.business.id, requested.id);
    expect(download.url.length).toBeGreaterThan(0);
    await expect(dataExportDownload(b.business.id, requested.id)).rejects.toMatchObject({ status: 404 });
    const listing = await listDataExports(a.business.id);
    expect(listing).toHaveLength(1);
    expect(await listDataExports(b.business.id)).toHaveLength(0);
  });

  itDb("purges expired exports and releases their storage", async () => {
    const { business, user } = await tenant();
    const requested = await requestDataExport({ userId: user.id, businessId: business.id }, { scope: ["customers"] });
    await processDataExport(requested.id);
    const { purgeExpiredExports } = await import("@/lib/services/data-governance");
    expect(await purgeExpiredExports()).toEqual({ purged: 0 });

    await db.update(dataExports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(dataExports.id, requested.id));
    expect(await purgeExpiredExports()).toEqual({ purged: 1 });
    const [row] = await db.select().from(dataExports).where(eq(dataExports.id, requested.id));
    expect(row).toMatchObject({ status: "EXPIRED", storageKey: null });
    const { storageObjects } = await import("@/db/schema");
    expect(await db.select().from(storageObjects).where(eq(storageObjects.businessId, business.id))).toHaveLength(0);
    await expect(dataExportDownload(business.id, requested.id)).rejects.toMatchObject({ status: 409 });
  });

  itDb("validates export scope and refuses unknown tables", async () => {
    const { business, user } = await tenant();
    await expect(requestDataExport({ userId: user.id, businessId: business.id }, { scope: ["secrets"] as never })).rejects.toMatchObject({ status: 400 });
    await expect(requestDataExport({ userId: user.id, businessId: business.id }, { scope: [], expiresInDays: 500 })).rejects.toMatchObject({ status: 400 });
  });
});

describe.skipIf(!hasTestDatabase())("retention policy", () => {
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

  itDb("stores and reads the policy with safe defaults", async () => {
    const { business } = await tenant();
    expect(await retentionPolicy(business.id)).toMatchObject({ callRecordingsDays: 90, auditLogsDays: 730 });
    await setRetentionPolicy(business.id, { callRecordingsDays: 30, callTranscriptsDays: 60, notificationsDays: 90, auditLogsDays: 365 });
    expect(await retentionPolicy(business.id)).toEqual({ callRecordingsDays: 30, callTranscriptsDays: 60, notificationsDays: 90, auditLogsDays: 365 });
    await expect(setRetentionPolicy(business.id, { callRecordingsDays: 0, callTranscriptsDays: 60, notificationsDays: 90, auditLogsDays: 365 })).rejects.toMatchObject({ status: 400 });
    const { privacyReport } = await import("@/lib/services/data-governance");
    expect((await privacyReport(business.id)).counts.leads).toBe(0);
  });

  itDb("clears expired call content without deleting the call row, and is idempotent", async () => {
    const { business } = await tenant();
    const customer = await createCustomer(business.id, "09123450000");
    const [call] = await db
      .insert(calls)
      .values({ businessId: business.id, phoneNumber: customer.phone, status: "COMPLETED", transcript: "متن تماس", summary: "خلاصه", recordingUrl: "https://files.example/rec.mp3" })
      .returning();
    const before = await db.select().from(calls).where(eq(calls.businessId, business.id));
    expect(before).toHaveLength(1);
    const policy = { callRecordingsDays: 30, callTranscriptsDays: 1, notificationsDays: 1, auditLogsDays: 30 };
    const first = await applyRetentionPolicy(business.id, policy, new Date(Date.now() + 10 * 86_400_000));
    expect(first.clearedCalls).toBe(1);
    const [after] = await db.select().from(calls).where(eq(calls.id, call.id));
    expect(after).toMatchObject({ transcript: null, summary: null, recordingUrl: null });
    expect(after.phoneNumber).toBe(customer.phone);
    const second = await applyRetentionPolicy(business.id, policy, new Date(Date.now() + 10 * 86_400_000));
    expect(second.clearedCalls).toBe(0);

    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.businessId, business.id), eq(auditLogs.action, "retention.applied")));
    expect(logs).toHaveLength(2);
    expect(logs[0].metadata).toMatchObject({ clearedCalls: 1 });
  });

  itDb("keeps calls inside the window untouched", async () => {
    const { business } = await tenant();
    await db.insert(calls).values({ businessId: business.id, phoneNumber: "09123456777", status: "COMPLETED", transcript: "تازه" });
    const result = await applyRetentionPolicy(business.id, { callRecordingsDays: 30, callTranscriptsDays: 365, notificationsDays: 30, auditLogsDays: 30 });
    expect(result.clearedCalls).toBe(0);
    const rows = await db.select().from(calls).where(eq(calls.businessId, business.id));
    expect(rows[0].transcript).toBe("تازه");
  });
});

describe.skipIf(!hasTestDatabase())("tenant offboarding state machine", () => {
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

  itDb("declares only legal transitions", () => {
    expect(TENANT_STATES).toEqual(["ACTIVE", "SUSPENDED", "PENDING_DELETION", "DELETED"]);
    expect(() => assertTransition("ACTIVE", "SUSPENDED")).not.toThrow();
    expect(() => assertTransition("ACTIVE", "PENDING_DELETION")).not.toThrow();
    expect(() => assertTransition("SUSPENDED", "PENDING_DELETION")).not.toThrow();
    expect(() => assertTransition("PENDING_DELETION", "DELETED")).not.toThrow();
    expect(() => assertTransition("ACTIVE", "DELETED")).toThrowError(/Illegal tenant transition/);
    expect(() => assertTransition("DELETED", "ACTIVE")).toThrowError(/Illegal tenant transition/);
  });

  itDb("requires platform admin + MFA + reason, and can be cancelled inside the grace window", async () => {
    const admin = await platformAdmin();
    const { business, user } = await tenant();
    await expect(requestTenantDeletion(user.id, { businessId: business.id, reason: "tenant asked to leave", confirm: true })).rejects.toMatchObject({ status: 403 });

    const requested = await requestTenantDeletion(admin.user.id, { businessId: business.id, reason: "tenant asked to leave", confirm: true, graceDays: 5 });
    expect(requested.status).toBe("PENDING_DELETION");
    expect((await db.select().from(businesses).where(eq(businesses.id, business.id)))[0].isActive).toBe(false);
    expect(await tenantsDueForPurge()).toHaveLength(0);

    const cancelled = await cancelTenantDeletion(admin.user.id, business.id);
    expect(cancelled.status).toBe("SUSPENDED");
    await expect(cancelTenantDeletion(admin.user.id, business.id)).rejects.toMatchObject({ status: 409 });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.businessId, business.id));
    expect(logs.map((row) => row.action).sort()).toEqual(["tenant.deletion_cancelled", "tenant.deletion_requested"]);
  });

  itDb("refuses to purge before the grace window and purges afterwards, keeping audit + billing rows", async () => {
    const admin = await platformAdmin();
    const { business } = await tenant();
    const customer = await createCustomer(business.id, "09129990000");
    await createLead(business.id, customer.id);

    await requestTenantDeletion(admin.user.id, { businessId: business.id, reason: "abandoned tenant", confirm: true, graceDays: 3 });
    await expect(purgeTenant(admin.user.id, { businessId: business.id, confirm: true })).rejects.toMatchObject({ status: 409 });

    expect(await tenantsDueForPurge(new Date(Date.now() + 4 * 86_400_000))).toHaveLength(1);
    const purged = await purgeTenant(admin.user.id, { businessId: business.id, confirm: true }, new Date(Date.now() + 4 * 86_400_000));
    expect(purged.purged).toBe(true);
    expect(purged.counts.leads).toBe(1);

    // The tenant row survives as a tombstone; content is gone.
    const [tombstone] = await db.select().from(businesses).where(eq(businesses.id, business.id));
    expect(tombstone).toMatchObject({ status: "DELETED", isActive: false, name: "Deleted tenant" });
    expect(tombstone.deletedAt).not.toBeNull();
    expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(0);
    const { leads } = await import("@/db/schema");
    expect(await db.select().from(leads).where(eq(leads.businessId, business.id))).toHaveLength(0);
    const purgeLog = await db.select().from(auditLogs).where(and(eq(auditLogs.businessId, business.id), eq(auditLogs.action, "tenant.purged")));
    expect(purgeLog).toHaveLength(1);
    expect(purgeLog[0].metadata).toMatchObject({ billingLedgerRetained: true });

    // Purging again is refused (terminal state).
    await expect(purgeTenant(admin.user.id, { businessId: business.id, confirm: true }, new Date(Date.now() + 5 * 86_400_000))).rejects.toMatchObject({ status: 409 });
  });

  itDb("audits who requested deletion and why", async () => {
    const admin = await platformAdmin();
    const { business } = await tenant();
    await requestTenantDeletion(admin.user.id, { businessId: business.id, reason: "non-payment and no response", confirm: true, graceDays: 7 });
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, business.id), eq(auditLogs.action, "tenant.deletion_requested")));
    expect(log.actorId).toBe(admin.user.id);
    expect(log.actorType).toBe("platform_admin");
    expect(log.metadata).toMatchObject({ reason: "non-payment and no response", graceDays: 7 });
  });
});
