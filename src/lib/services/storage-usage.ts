import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, storageObjects } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { assertTenantScope } from "@/lib/request-context";
import { logWarn } from "@/lib/logger";
import { adjustConsumedInTransaction, type QuotaTx } from "@/lib/services/quotas";
import { getStorageProvider, type StorageProvider } from "@/lib/providers/storage";

/**
 * Authoritative object-storage accounting.
 *
 * `storage_objects` is the tenant-scoped ledger of every byte the app owns in
 * object storage, and `storage_bytes` quota consumption is derived from the
 * DELTA of that ledger — so replacing a file adjusts usage instead of double
 * counting, and deleting always releases quota (never restores an allowance by
 * silently resetting the window).
 */

export const StorageCategorySchema = z.enum(["knowledge", "recording", "generated_audio", "export", "attachment", "other"]);
export type StorageCategory = z.infer<typeof StorageCategorySchema>;

export type RecordObjectInput = {
  businessId: string;
  key: string;
  bytes: number;
  contentType?: string | null;
  category: StorageCategory;
  sourceType?: string | null;
  sourceId?: string | null;
  checksum?: string | null;
  retainedUntil?: Date | null;
  legalHold?: boolean;
};

function toBigIntString(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new AppError(400, "VALIDATION_ERROR", "Object size must be a non-negative number");
  return String(Math.round(bytes));
}

/**
 * Record (or update) one stored object and move the tenant's `storage_bytes`
 * consumption by the difference. Quota admission happens inside the same
 * transaction as the ledger write, so a rejected upload cannot leave a
 * phantom size on the books.
 */
export async function recordStoredObject(tx: QuotaTx, input: RecordObjectInput) {
  assertTenantScope(input.businessId);
  const bytes = toBigIntString(input.bytes);
  const [existing] = await tx
    .select({ id: storageObjects.id, bytes: storageObjects.bytes })
    .from(storageObjects)
    .where(and(eq(storageObjects.businessId, input.businessId), eq(storageObjects.key, input.key)))
    .for("update");
  const previous = existing ? Number(existing.bytes) : 0;
  const delta = Number(bytes) - previous;
  if (existing) {
    await tx
      .update(storageObjects)
      .set({
        bytes,
        contentType: input.contentType ?? null,
        category: input.category,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        checksum: input.checksum ?? null,
        retainedUntil: input.retainedUntil ?? null,
        legalHold: input.legalHold ?? false,
        updatedAt: new Date(),
      })
      .where(eq(storageObjects.id, existing.id));
  } else {
    await tx.insert(storageObjects).values({
      businessId: input.businessId,
      key: input.key,
      bytes,
      contentType: input.contentType ?? null,
      category: input.category,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      checksum: input.checksum ?? null,
      retainedUntil: input.retainedUntil ?? null,
      legalHold: input.legalHold ?? false,
    });
  }
  if (delta !== 0) await adjustConsumedInTransaction(tx, input.businessId, "storage_bytes", delta);
  return { key: input.key, bytes: Number(bytes), previousBytes: previous, delta };
}

/** Record an object inside its own transaction (uploads that already happened). */
export async function recordStoredObjectStandalone(input: RecordObjectInput) {
  assertTenantScope(input.businessId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM businesses WHERE id = ${input.businessId} FOR UPDATE`);
    return recordStoredObject(tx, input);
  });
}

/** Remove an object from the ledger and release its quota. Idempotent. */
export async function forgetStoredObject(tx: QuotaTx, businessId: string, key: string) {
  assertTenantScope(businessId);
  const [existing] = await tx
    .select({ id: storageObjects.id, bytes: storageObjects.bytes })
    .from(storageObjects)
    .where(and(eq(storageObjects.businessId, businessId), eq(storageObjects.key, key)))
    .for("update");
  if (!existing) return { removed: false, bytes: 0 };
  await tx.delete(storageObjects).where(eq(storageObjects.id, existing.id));
  await adjustConsumedInTransaction(tx, businessId, "storage_bytes", -Number(existing.bytes));
  return { removed: true, bytes: Number(existing.bytes) };
}

export async function forgetStoredObjectStandalone(businessId: string, key: string) {
  assertTenantScope(businessId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM businesses WHERE id = ${businessId} FOR UPDATE`);
    return forgetStoredObject(tx, businessId, key);
  });
}

/** Delete every object owned by one source (document, call, export…). */
export async function deleteObjectsForSource(businessId: string, sourceType: string, sourceId: string): Promise<{ deleted: number; bytes: number }> {
  assertTenantScope(businessId);
  const rows = await db
    .select({ key: storageObjects.key, bytes: storageObjects.bytes })
    .from(storageObjects)
    .where(and(eq(storageObjects.businessId, businessId), eq(storageObjects.sourceType, sourceType), eq(storageObjects.sourceId, sourceId)));
  let deleted = 0;
  let bytes = 0;
  for (const row of rows) {
    const provider = getStorageProvider();
    try {
      await provider.delete(row.key);
    } catch (err) {
      logWarn("Object deletion failed; ledger entry retained for reconciliation", {
        businessId,
        operation: "storage.delete",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const result = await forgetStoredObjectStandalone(businessId, row.key);
    if (result.removed) {
      deleted++;
      bytes += result.bytes;
    }
  }
  return { deleted, bytes };
}

export async function storageUsageBytes(businessId: string): Promise<number> {
  assertTenantScope(businessId);
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${storageObjects.bytes}), 0)::text` })
    .from(storageObjects)
    .where(eq(storageObjects.businessId, businessId));
  return Number(row?.total ?? 0);
}

export type StorageReconciliation = {
  businessId: string;
  ledgerBytes: number;
  ledgerObjects: number;
  providerObjects: number | null;
  missingInProvider: string[];
  missingInLedger: string[];
  sizeMismatches: { key: string; ledgerBytes: number; providerBytes: number }[];
  quotaConsumedBytes: string;
  driftBytes: number;
  providerListingSupported: boolean;
};

/**
 * Reconcile the metadata ledger against the object store itself.
 * Providers that cannot list objects report `providerListingSupported: false`
 * (never a fabricated "in sync" result).
 */
export async function reconcileStorage(businessId: string, opts?: { provider?: StorageProvider; fix?: boolean }): Promise<StorageReconciliation> {
  assertTenantScope(businessId);
  const provider = opts?.provider ?? getStorageProvider();
  const rows = await db
    .select({ key: storageObjects.key, bytes: storageObjects.bytes })
    .from(storageObjects)
    .where(eq(storageObjects.businessId, businessId));
  const ledgerBytes = rows.reduce((total, row) => total + Number(row.bytes), 0);

  const [bucket] = await db.execute<{ consumed: string }>(sql`
    SELECT consumed FROM quota_buckets
    WHERE business_id = ${businessId} AND meter = 'storage_bytes'
    ORDER BY window_start DESC LIMIT 1`).then((res) => res.rows as { consumed: string }[]);
  const quotaConsumedBytes = bucket?.consumed ?? "0.0000";

  let providerObjects: number | null = null;
  let missingInProvider: string[] = [];
  let missingInLedger: string[] = [];
  let sizeMismatches: { key: string; ledgerBytes: number; providerBytes: number }[] = [];
  const supported = typeof provider.list === "function";
  if (supported) {
    const prefix = `business/${businessId}/`;
    const listed = await provider.list!(prefix);
    providerObjects = listed.length;
    const byKey = new Map(listed.map((item) => [item.key, item.bytes]));
    missingInProvider = rows.filter((row) => !byKey.has(row.key)).map((row) => row.key);
    const ledgerKeys = new Set(rows.map((row) => row.key));
    missingInLedger = listed.filter((item) => !ledgerKeys.has(item.key)).map((item) => item.key);
    sizeMismatches = rows
      .filter((row) => byKey.has(row.key) && byKey.get(row.key) !== Number(row.bytes))
      .map((row) => ({ key: row.key, ledgerBytes: Number(row.bytes), providerBytes: byKey.get(row.key)! }));
  }
  const driftBytes = Math.round(ledgerBytes - Number(quotaConsumedBytes));

  if (opts?.fix && supported) {
    // Adopt provider-side truth for missing objects and drop phantom ledger rows.
    const prefix = `business/${businessId}/`;
    const listed = await provider.list!(prefix);
    for (const item of listed) {
      if (!rows.some((row) => row.key === item.key)) {
        await recordStoredObjectStandalone({ businessId, key: item.key, bytes: item.bytes, category: "other", sourceType: "reconciliation" });
      }
    }
    for (const key of missingInProvider) await forgetStoredObjectStandalone(businessId, key);
  }

  return {
    businessId,
    ledgerBytes,
    ledgerObjects: rows.length,
    providerObjects,
    missingInProvider,
    missingInLedger,
    sizeMismatches,
    quotaConsumedBytes,
    driftBytes,
    providerListingSupported: supported,
  };
}

/** Operator-facing storage summary (no cross-tenant data). */
export async function storageSummary(businessId: string) {
  assertTenantScope(businessId);
  const rows = await db
    .select({ category: storageObjects.category, bytes: sql<string>`COALESCE(SUM(${storageObjects.bytes}), 0)::text`, objects: sql<number>`count(*)::int` })
    .from(storageObjects)
    .where(eq(storageObjects.businessId, businessId))
    .groupBy(storageObjects.category);
  return {
    totalBytes: rows.reduce((total, row) => total + Number(row.bytes), 0),
    categories: rows.map((row) => ({ category: row.category, bytes: Number(row.bytes), objects: row.objects })),
  };
}

/** Append an audit entry for a storage deletion (retention/legal evidence). */
export async function auditStorageDeletion(input: { businessId: string; actorId?: string; keys: string[]; reason: string; requestId?: string }) {
  assertTenantScope(input.businessId);
  await db.insert(auditLogs).values({
    businessId: input.businessId,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "storage.deleted",
    entityType: "storage_object",
    entityId: input.keys[0] ?? null,
    requestId: input.requestId,
    metadata: { objectCount: input.keys.length, keys: input.keys.slice(0, 50), reason: input.reason },
  });
}
