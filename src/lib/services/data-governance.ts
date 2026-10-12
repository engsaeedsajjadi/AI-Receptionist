import { gzipSync } from "node:zlib";
import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLogs,
  businesses,
  calls,
  customers,
  dataExports,
  knowledgeDocuments,
  leads,
  notifications,
  usageRecords,
  users,
  webhookDeliveries,
} from "@/db/schema";
import { parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { getStorageProvider, tenantKey } from "@/lib/providers/storage";
import { requestContext } from "@/lib/request-context";
import { recordStoredObjectStandalone, forgetStoredObjectStandalone } from "@/lib/services/storage-usage";
import { enqueueOutbox } from "@/lib/services/outbox";
import { notify } from "@/lib/services/notifications";

/**
 * Tenant data governance: exports, retention and offboarding.
 *
 * - Exports are assembled per tenant, written to tenant-scoped storage keys and
 *   expire; the archive contains the tenant's own rows only (the query filters
 *   on `businessId` for every table).
 * - Retention policies purge expired rows/objects but never cross a tenant
 *   boundary, and every purge is audited with counts only (never content).
 * - Offboarding is a state machine ACTIVE → SUSPENDED → PENDING_DELETION →
 *   DELETED with a grace window; deletion is refused while the grace window is
 *   open and always requires an explicit platform reason.
 */

export const EXPORT_TABLES = ["customers", "leads", "calls", "appointments", "knowledge_documents", "usage_records", "notifications"] as const;

export const ExportRequestSchema = z
  .object({
    scope: z.array(z.enum(EXPORT_TABLES)).min(1).max(EXPORT_TABLES.length).optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();

async function collectExport(businessId: string, scope: readonly string[]) {
  const data: Record<string, unknown[]> = {};
  for (const table of scope) {
    switch (table) {
      case "customers":
        data.customers = await db.select().from(customers).where(eq(customers.businessId, businessId)).limit(50_000);
        break;
      case "leads":
        data.leads = await db.select().from(leads).where(eq(leads.businessId, businessId)).limit(50_000);
        break;
      case "calls":
        data.calls = await db.select().from(calls).where(eq(calls.businessId, businessId)).limit(50_000);
        break;
      case "appointments": {
        const { appointments } = await import("@/db/schema");
        data.appointments = await db.select().from(appointments).where(eq(appointments.businessId, businessId)).limit(50_000);
        break;
      }
      case "knowledge_documents":
        data.knowledgeDocuments = await db
          .select({
            id: knowledgeDocuments.id,
            title: knowledgeDocuments.title,
            status: knowledgeDocuments.status,
            lifecycle: knowledgeDocuments.lifecycle,
            version: knowledgeDocuments.version,
            createdAt: knowledgeDocuments.createdAt,
          })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.businessId, businessId))
          .limit(50_000);
        break;
      case "usage_records":
        data.usageRecords = await db.select().from(usageRecords).where(eq(usageRecords.businessId, businessId)).limit(100_000);
        break;
      case "notifications":
        data.notifications = await db.select().from(notifications).where(eq(notifications.businessId, businessId)).limit(50_000);
        break;
    }
  }
  return data;
}

/** Request an export; the archive is produced synchronously by the worker. */
export async function requestDataExport(actor: { userId: string; businessId: string }, raw: unknown) {
  const input = parseWith(ExportRequestSchema, raw ?? {});
  const scope = input.scope ?? [...EXPORT_TABLES];
  const [row] = await db
    .insert(dataExports)
    .values({
      businessId: actor.businessId,
      requestedBy: actor.userId,
      status: "PENDING",
      scope,
      expiresAt: new Date(Date.now() + (input.expiresInDays ?? 7) * 86_400_000),
    })
    .returning();
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "export.requested",
    entityType: "data_export",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { scope },
  });
  return row;
}

/** Build a pending export. Idempotent: a claimed export is skipped. */
export async function processDataExport(exportId: string): Promise<{ status: string; bytes?: number; skipped?: boolean }> {
  const claimed = await db
    .update(dataExports)
    .set({ status: "PROCESSING" })
    .where(and(eq(dataExports.id, exportId), eq(dataExports.status, "PENDING")))
    .returning();
  const row = claimed[0];
  if (!row) return { status: "skipped", skipped: true };
  try {
    const [business] = await db.select({ name: businesses.name, slug: businesses.slug }).from(businesses).where(eq(businesses.id, row.businessId));
    const data = await collectExport(row.businessId, row.scope);
    const archive = {
      exportedAt: new Date().toISOString(),
      businessId: row.businessId,
      business: business ?? null,
      scope: row.scope,
      rowCounts: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value.length])),
      data,
    };
    const body = gzipSync(Buffer.from(JSON.stringify(archive), "utf8"));
    const key = tenantKey(row.businessId, "exports", `${row.id}.json.gz`);
    await getStorageProvider().upload({ key, data: body, contentType: "application/gzip" });
    await recordStoredObjectStandalone({
      businessId: row.businessId,
      key,
      bytes: body.length,
      contentType: "application/gzip",
      category: "export",
      sourceType: "data_export",
      sourceId: row.id,
      retainedUntil: row.expiresAt,
    });
    const [updated] = await db
      .update(dataExports)
      .set({ status: "READY", storageKey: key, bytes: String(body.length), rowCounts: archive.rowCounts, completedAt: new Date() })
      .where(and(eq(dataExports.id, row.id), eq(dataExports.businessId, row.businessId)))
      .returning();
    await db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        businessId: row.businessId,
        topic: "export.ready",
        idempotencyKey: `export.ready:${row.id}`,
        payload: { businessId: row.businessId, id: row.id, exportId: row.id, bytes: body.length, rowCounts: archive.rowCounts },
      });
    });
    await notify({
      businessId: row.businessId,
      userId: row.requestedBy,
      type: "export_ready",
      title: "خروجی داده‌ها آماده است",
      message: `خروجی درخواستی (${row.id}) آماده شد و ${inputDays(row.expiresAt)} روز اعتبار دارد.`,
      idempotencyKey: `export-ready:${row.id}`,
    });
    logInfo("Data export produced", {
      businessId: row.businessId,
      operation: "export.process",
      status: "ok",
    });
    return { status: updated.status, bytes: body.length };
  } catch (err) {
    await db
      .update(dataExports)
      .set({ status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "export_failed" })
      .where(and(eq(dataExports.id, row.id), eq(dataExports.businessId, row.businessId)));
    logWarn("Data export failed", {
      businessId: row.businessId,
      operation: "export.process",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function inputDays(date: Date | null): number {
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

export async function listDataExports(businessId: string) {
  return db
    .select({
      id: dataExports.id,
      status: dataExports.status,
      scope: dataExports.scope,
      bytes: dataExports.bytes,
      rowCounts: dataExports.rowCounts,
      error: dataExports.error,
      expiresAt: dataExports.expiresAt,
      completedAt: dataExports.completedAt,
      createdAt: dataExports.createdAt,
    })
    .from(dataExports)
    .where(eq(dataExports.businessId, businessId))
    .orderBy(desc(dataExports.createdAt))
    .limit(100);
}

/** Signed download URL for a READY export (tenant-scoped key). */
export async function dataExportDownload(businessId: string, exportId: string) {
  const [row] = await db
    .select()
    .from(dataExports)
    .where(and(eq(dataExports.id, exportId), eq(dataExports.businessId, businessId)));
  if (!row) throw new AppError(404, "NOT_FOUND", "Export not found");
  if (row.status !== "READY" || !row.storageKey) throw new AppError(409, "CONFLICT", "Export is not ready yet");
  if (row.expiresAt && row.expiresAt <= new Date()) throw new AppError(410, "CONFLICT", "Export has expired");
  const url = await getStorageProvider().getSignedUrl(row.storageKey, 3600);
  return { url, bytes: row.bytes ? Number(row.bytes) : null, expiresAt: row.expiresAt };
}

/**
 * Delete expired exports (rows + stored objects + ledger entries).
 * Bounded per run so a large backlog cannot stall the worker.
 */
export async function purgeExpiredExports(limit = 50): Promise<{ purged: number }> {
  const expired = await db
    .select({ id: dataExports.id, businessId: dataExports.businessId, storageKey: dataExports.storageKey })
    .from(dataExports)
    .where(and(isNotNull(dataExports.expiresAt), lt(dataExports.expiresAt, new Date())))
    .limit(limit);
  let purged = 0;
  for (const row of expired) {
    if (row.storageKey) {
      try {
        await getStorageProvider().delete(row.storageKey);
      } catch (err) {
        logWarn("Expired export object could not be deleted", {
          businessId: row.businessId,
          operation: "export.purge",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await forgetStoredObjectStandalone(row.businessId, row.storageKey);
    }
    await db.update(dataExports).set({ status: "EXPIRED", storageKey: null }).where(and(eq(dataExports.id, row.id), eq(dataExports.businessId, row.businessId)));
    purged += 1;
  }
  return { purged };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export const RetentionPolicySchema = z
  .object({
    callRecordingsDays: z.number().int().min(1).max(3650),
    callTranscriptsDays: z.number().int().min(1).max(3650),
    notificationsDays: z.number().int().min(1).max(3650),
    auditLogsDays: z.number().int().min(30).max(3650),
  })
  .strict();

/**
 * Purge tenant data that outlived its retention window. Content is replaced
 * (transcripts/summaries) before rows are removed; counts are audited.
 */
export async function applyRetentionPolicy(businessId: string, raw: unknown, now = new Date()) {
  const policy = parseWith(RetentionPolicySchema, raw);
  const callCutoff = new Date(now.getTime() - policy.callTranscriptsDays * 86_400_000);
  const notificationCutoff = new Date(now.getTime() - policy.notificationsDays * 86_400_000);
  const auditCutoff = new Date(now.getTime() - policy.auditLogsDays * 86_400_000);

  const clearedCalls = await db
    .update(calls)
    .set({ transcript: null, summary: null, recordingUrl: null })
    .where(
      and(
        eq(calls.businessId, businessId),
        lt(calls.createdAt, callCutoff),
        sql`(${calls.transcript} IS NOT NULL OR ${calls.summary} IS NOT NULL OR ${calls.recordingUrl} IS NOT NULL)`,
      ),
    )
    .returning({ id: calls.id });

  const removedNotifications = await db
    .delete(notifications)
    .where(and(eq(notifications.businessId, businessId), lt(notifications.createdAt, notificationCutoff)))
    .returning({ id: notifications.id });

  const removedDeliveries = await db
    .delete(webhookDeliveries)
    .where(and(eq(webhookDeliveries.businessId, businessId), lt(webhookDeliveries.createdAt, auditCutoff)))
    .returning({ id: webhookDeliveries.id });

  await db.insert(auditLogs).values({
    businessId,
    actorType: "system",
    action: "retention.applied",
    entityType: "business",
    entityId: businessId,
    metadata: {
      policy,
      clearedCalls: clearedCalls.length,
      removedNotifications: removedNotifications.length,
      removedWebhookDeliveries: removedDeliveries.length,
    },
  });
  logInfo("Retention policy applied", { businessId, operation: "retention.apply", status: "ok" });
  return {
    clearedCalls: clearedCalls.length,
    removedNotifications: removedNotifications.length,
    removedWebhookDeliveries: removedDeliveries.length,
  };
}

export async function setRetentionPolicy(businessId: string, raw: unknown) {
  const policy = parseWith(RetentionPolicySchema, raw);
  const [row] = await db
    .update(businesses)
    .set({ settings: sql`jsonb_set(${businesses.settings}, '{retention}', ${JSON.stringify(policy)}::jsonb, true)`, updatedAt: new Date() })
    .where(eq(businesses.id, businessId))
    .returning({ id: businesses.id, settings: businesses.settings });
  if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  await db.insert(auditLogs).values({
    businessId,
    actorType: "user",
    action: "retention.policy_updated",
    entityType: "business",
    entityId: businessId,
    metadata: { policy },
  });
  return policy;
}

export async function retentionPolicy(businessId: string) {
  const [row] = await db.select({ settings: businesses.settings }).from(businesses).where(eq(businesses.id, businessId));
  if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const stored = (row.settings as { retention?: unknown }).retention;
  const parsed = RetentionPolicySchema.safeParse(stored);
  return parsed.success
    ? parsed.data
    : { callRecordingsDays: 90, callTranscriptsDays: 365, notificationsDays: 180, auditLogsDays: 730 };
}

// ---------------------------------------------------------------------------
// Offboarding state machine
// ---------------------------------------------------------------------------

export const TENANT_STATES = ["ACTIVE", "SUSPENDED", "PENDING_DELETION", "DELETED"] as const;
export type TenantState = (typeof TENANT_STATES)[number];

/**
 * Legal offboarding transitions.
 *  - ACTIVE → SUSPENDED            : incident/compliance action (reversible)
 *  - ACTIVE → PENDING_DELETION     : customer-initiated offboarding (with grace)
 *  - SUSPENDED → ACTIVE            : reinstate
 *  - SUSPENDED → PENDING_DELETION  : offboard a suspended tenant
 *  - PENDING_DELETION → SUSPENDED  : cancel inside the grace window (stays off)
 *  - PENDING_DELETION → DELETED    : hard purge after the grace window (terminal)
 * Skipping suspension is allowed because suspension is a separate control;
 * going straight from ACTIVE to DELETED stays forbidden.
 */
const TRANSITIONS: Record<TenantState, TenantState[]> = {
  ACTIVE: ["SUSPENDED", "PENDING_DELETION"],
  SUSPENDED: ["ACTIVE", "PENDING_DELETION"],
  PENDING_DELETION: ["SUSPENDED", "DELETED"],
  DELETED: [],
};

export function assertTransition(from: TenantState, to: TenantState) {
  if (!TRANSITIONS[from].includes(to)) throw new AppError(409, "CONFLICT", `Illegal tenant transition ${from} → ${to}`);
}

export const OffboardSchema = z
  .object({
    businessId: z.string().uuid(),
    reason: z.string().trim().min(10).max(500),
    graceDays: z.number().int().min(1).max(90).optional(),
    confirm: z.literal(true),
  })
  .strict();

/**
 * Move a tenant to PENDING_DELETION. The grace window must elapse before
 * `purgeTenant` will delete anything, and the tenant can be restored to
 * SUSPENDED inside that window.
 */
export async function requestTenantDeletion(actorId: string, raw: unknown, now = new Date()) {
  const input = parseWith(OffboardSchema, raw);
  const { requirePlatformAdmin } = await import("@/lib/services/platform");
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).for("update");
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
    assertTransition(business.status as TenantState, "PENDING_DELETION");
    const scheduled = new Date(now.getTime() + (input.graceDays ?? 14) * 86_400_000);
    const [row] = await tx
      .update(businesses)
      .set({
        status: "PENDING_DELETION",
        isActive: false,
        deletionRequestedAt: now,
        deletionScheduledFor: scheduled,
        updatedAt: now,
      })
      .where(eq(businesses.id, input.businessId))
      .returning({ id: businesses.id, status: businesses.status, deletionScheduledFor: businesses.deletionScheduledFor });
    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: "platform_admin",
      actorId,
      action: "tenant.deletion_requested",
      entityType: "business",
      entityId: input.businessId,
      requestId: requestContext.getStore()?.requestId,
      metadata: { reason: input.reason, graceDays: input.graceDays ?? 14, deletionScheduledFor: scheduled.toISOString() },
    });
    return row;
  });
}

/** Cancel a pending deletion inside the grace window. */
export async function cancelTenantDeletion(actorId: string, businessId: string) {
  const { requirePlatformAdmin } = await import("@/lib/services/platform");
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).for("update");
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
    if (business.status !== "PENDING_DELETION") throw new AppError(409, "CONFLICT", "Tenant is not pending deletion");
    const [row] = await tx
      .update(businesses)
      .set({ status: "SUSPENDED", deletionRequestedAt: null, deletionScheduledFor: null, updatedAt: new Date() })
      .where(eq(businesses.id, businessId))
      .returning({ id: businesses.id, status: businesses.status });
    await tx.insert(auditLogs).values({
      businessId,
      actorType: "platform_admin",
      actorId,
      action: "tenant.deletion_cancelled",
      entityType: "business",
      entityId: businessId,
      requestId: requestContext.getStore()?.requestId,
      metadata: {},
    });
    return row;
  });
}

/**
 * Hard delete after the grace window. Requires the platform administrator to
 * pass `confirm: true`, refuses while the window is open, and records the purge
 * (counts only) before removing the business row (cascade removes its data).
 */
export async function purgeTenant(actorId: string, input: { businessId: string; confirm: true }, now = new Date()) {
  const { requirePlatformAdmin } = await import("@/lib/services/platform");
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).for("update");
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
    assertTransition(business.status as TenantState, "DELETED");
    if (!business.deletionScheduledFor || business.deletionScheduledFor > now) {
      throw new AppError(409, "CONFLICT", "Deletion grace window has not elapsed");
    }
    const count = async (table: "users" | "calls" | "leads" | "customers" | "knowledge_documents" | "notifications" | "usage_records") => {
      const rows = await tx.execute(sql.raw(`SELECT count(*)::text AS count FROM ${table} WHERE business_id = '${input.businessId}'`));
      return Number((rows.rows[0] as { count?: string } | undefined)?.count ?? 0);
    };
    const counts = {
      users: await count("users"),
      calls: await count("calls"),
      leads: await count("leads"),
      customers: await count("customers"),
      knowledgeDocuments: await count("knowledge_documents"),
      notifications: await count("notifications"),
      usageRecords: await count("usage_records"),
    };
    // Purge tenant content but keep the business row as a tombstone so the
    // audit trail, subscription history and billing ledger stay coherent
    // (billing history is legally retained; nothing here is re-activated).
    const tables = [
      "webhook_deliveries",
      "retrieval_events",
      "storage_objects",
      "knowledge_chunks",
      "knowledge_documents",
      "call_messages",
      "calls",
      "lead_notes",
      "leads",
      "customers",
      "appointments",
      "notifications",
      "usage_records",
      "automation_jobs",
      "automation_dispatches",
      "outbox_events",
      "provider_events",
      "webhook_endpoints",
      "api_keys",
      "service_accounts",
      "invitations",
      "user_roles",
      "roles",
      "agent_versions",
      "agents",
      "properties",
      "crm_tasks",
      "crm_opportunities",
      "crm_pipelines",
      "identity_tokens",
      "refresh_tokens",
      "oauth_accounts",
      "data_exports",
      "quota_buckets",
      "quota_reservations",
      "quota_overrides",
      "users",
    ];
    for (const table of tables) {
      await tx.execute(sql.raw(`DELETE FROM ${table} WHERE business_id = '${input.businessId}'`));
    }
    await tx
      .update(businesses)
      .set({ status: "DELETED", isActive: false, deletedAt: now, name: "Deleted tenant", phone: null, address: null, settings: {}, updatedAt: now })
      .where(eq(businesses.id, input.businessId));
    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: "platform_admin",
      actorId,
      action: "tenant.purged",
      entityType: "business",
      entityId: input.businessId,
      requestId: requestContext.getStore()?.requestId,
      metadata: { counts, purgedAt: now.toISOString(), billingLedgerRetained: true },
    });
    logWarn("Tenant purged after grace window", { businessId: input.businessId, operation: "tenant.purge", status: "deleted" });
    return { businessId: input.businessId, purged: true, counts };
  });
}

/** Tenants whose grace window has elapsed and are ready to purge. */
export async function tenantsDueForPurge(now = new Date()) {
  return db
    .select({ id: businesses.id, name: businesses.name, deletionScheduledFor: businesses.deletionScheduledFor })
    .from(businesses)
    .where(and(eq(businesses.status, "PENDING_DELETION"), isNotNull(businesses.deletionScheduledFor), lt(businesses.deletionScheduledFor, now)))
    .limit(50);
}

/** Read-only privacy report for a tenant (what we hold, and for how long). */
export async function privacyReport(businessId: string) {
  const [callsCount, customersCount, leadsCount, docsCount, notificationsCount, exportsCount] = await Promise.all([
    db.select({ count: sql<string>`count(*)::text` }).from(calls).where(eq(calls.businessId, businessId)),
    db.select({ count: sql<string>`count(*)::text` }).from(customers).where(eq(customers.businessId, businessId)),
    db.select({ count: sql<string>`count(*)::text` }).from(leads).where(eq(leads.businessId, businessId)),
    db.select({ count: sql<string>`count(*)::text` }).from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId)),
    db.select({ count: sql<string>`count(*)::text` }).from(notifications).where(eq(notifications.businessId, businessId)),
    db.select({ count: sql<string>`count(*)::text` }).from(dataExports).where(and(eq(dataExports.businessId, businessId), isNull(dataExports.completedAt))),
  ]);
  return {
    counts: {
      calls: Number(callsCount[0]?.count ?? 0),
      customers: Number(customersCount[0]?.count ?? 0),
      leads: Number(leadsCount[0]?.count ?? 0),
      knowledgeDocuments: Number(docsCount[0]?.count ?? 0),
      notifications: Number(notificationsCount[0]?.count ?? 0),
      pendingExports: Number(exportsCount[0]?.count ?? 0),
    },
    retention: await retentionPolicy(businessId),
    exportAvailable: true,
    deletionProcess: "platform_admin_mfa_reason_grace_window",
  };
}
