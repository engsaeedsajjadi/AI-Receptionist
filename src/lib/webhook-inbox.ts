import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { logInfo, logWarn } from "@/lib/logger";

/**
 * Durable webhook event inbox (§1).
 *
 * The Redis SETNX claim it replaces was volatile: a Redis restart, eviction,
 * or flush silently re-armed every in-flight key and redeliveries would
 * RE-EXECUTE instead of collapsing. This inbox is Postgres-backed and is the
 * single source of truth for webhook idempotency:
 *
 *   RECEIVED → PROCESSING → COMPLETED
 *                    ↘ FAILED (retryable — a redelivery re-claims it)
 *
 * Claim identity is the GLOBAL (scope, idempotencyKey) pair: a redelivery
 * must hit the same row regardless of the asserted tenant. Tenant attribution
 * (businessId) is audit metadata, never part of the key.
 *
 * Concurrency contract (all claimants serialize on SELECT ... FOR UPDATE):
 * - first claimant wins → `process` (exactly one worker per delivery);
 * - COMPLETED → `duplicate` (return the standard duplicate response);
 * - FAILED / RECEIVED / lease-expired PROCESSING → re-claimed → `process`;
 * - PROCESSING with a live lease → bounded wait for the winner to finish,
 *   then `duplicate` — or `busy` (HTTP 429 + Retry-After) when the winner is
 *   still working, so the gateway retries later instead of being acked early
 *   (acking a concurrent duplicate while the first attempt is still running
 *   would LOSE the event if the first attempt then failed);
 * - same key + different payload hash → `conflict` (HTTP 409, terminal —
 *   never silently replay one delivery's outcome for another delivery's bytes).
 */

export type WebhookInboxStatus = "RECEIVED" | "PROCESSING" | "COMPLETED" | "FAILED";

export type InboxClaim =
  | { decision: "process"; eventId: string; leaseToken: string; attempts: number }
  | { decision: "duplicate"; eventId: string }
  | { decision: "conflict"; eventId: string }
  | { decision: "busy"; eventId: string; retryAfterSeconds: number };

const DEFAULT_LEASE_TTL_SECONDS = 300; // worst-case sync turn ≪ 5 min
const DEFAULT_WAIT_MS = 8000; // bounded wait for a live PROCESSING winner
const POLL_INTERVAL_MS = 100;
const MAX_RESULT_BYTES = 8192;
const MAX_ERROR_CHARS = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function leaseExpired(leaseExpiresAt: Date | null): boolean {
  return leaseExpiresAt === null || leaseExpiresAt.getTime() <= Date.now();
}

/** Deterministic JSON encoding (recursive key sort, like JSON for undefined). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * sha256 over the canonical payload encoding. Key order / whitespace
 * differences collapse; any content difference fails closed as a conflict.
 */
export function canonicalPayloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function toStorableResult(result: unknown): Record<string, unknown> | null {
  if (result === null || result === undefined) return null;
  const obj = (
    typeof result === "object" && !Array.isArray(result) ? result : { value: result }
  ) as Record<string, unknown>;
  try {
    if (JSON.stringify(obj).length <= MAX_RESULT_BYTES) return obj;
    return { truncated: true, keys: Object.keys(obj).slice(0, 50) };
  } catch {
    return { truncated: true, unserializable: true };
  }
}

function toErrorMessage(err: unknown): string {
  let message: string;
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const { code, message: text } = err as { code: unknown; message: unknown };
    message = `${String(code)}: ${String(text)}`;
  } else if (err instanceof Error) {
    message = `${err.name}: ${err.message}`;
  } else {
    message = String(err);
  }
  return message.slice(0, MAX_ERROR_CHARS);
}

/**
 * Transition one row RECEIVED/FAILED/expired-PROCESSING → PROCESSING under a
 * row lock. Returns the lease on success, null when another claimant won the
 * race (caller re-reads) or the payload hash conflicts (caller 409s).
 */
async function tryClaimRow(
  eventId: string,
  payloadHash: string,
  leaseTtlSeconds: number,
): Promise<{ eventId: string; leaseToken: string; attempts: number } | null> {
  const leaseToken = randomUUID();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
      .for("update")
      .limit(1);
    if (!row) return null;
    // Fail closed on content mismatch (NULL hash = legacy row: adopt it).
    if (row.payloadHash !== null && row.payloadHash !== payloadHash) return null;
    const claimable =
      row.status === "RECEIVED" ||
      row.status === "FAILED" ||
      (row.status === "PROCESSING" && leaseExpired(row.leaseExpiresAt));
    if (!claimable) return null;
    const [updated] = await tx
      .update(webhookEvents)
      .set({
        status: "PROCESSING",
        payloadHash: row.payloadHash ?? payloadHash,
        attempts: row.attempts + 1,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + leaseTtlSeconds * 1000),
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(webhookEvents.id, eventId))
      .returning({ id: webhookEvents.id, attempts: webhookEvents.attempts });
    if (!updated) return null;
    return { eventId: updated.id, leaseToken, attempts: updated.attempts };
  });
}

async function readRow(scope: string, key: string) {
  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.scope, scope), eq(webhookEvents.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

/**
 * Receive (durably) + claim one webhook delivery. The receive INSERT commits
 * before the claim UPDATE commits, so a crash between the two leaves a
 * RECEIVED row that any redelivery immediately claims — the delivery is never
 * lost and never processed twice.
 */
export async function claimWebhookInbox(opts: {
  scope: string;
  key: string;
  payloadHash: string;
  businessId?: string | null;
  leaseTtlSeconds?: number;
  /** Bounded wait for a live PROCESSING winner. 0 = never wait (busy fast). */
  waitMs?: number;
}): Promise<InboxClaim> {
  const leaseTtlSeconds = opts.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;

  // Step 1: durable receive. The unique (scope, key) constraint decides the
  // winner; losers fall through to the read path below.
  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      scope: opts.scope,
      idempotencyKey: opts.key,
      status: "RECEIVED",
      payloadHash: opts.payloadHash,
      businessId: opts.businessId ?? null,
    })
    .onConflictDoNothing({ target: [webhookEvents.scope, webhookEvents.idempotencyKey] })
    .returning({ id: webhookEvents.id });

  if (inserted) {
    const claimed = await tryClaimRow(inserted.id, opts.payloadHash, leaseTtlSeconds);
    // AT THIS POINT the row is ours alone (we just created it) UNLESS a
    // racing claimant read it between our INSERT commit and our claim — in
    // which case we join the read path as the waiter. Either way exactly one
    // worker processes.
    if (claimed) return { decision: "process", ...claimed };
  }

  // Step 2: read + decide, with a bounded wait for a live winner.
  for (;;) {
    const row = await readRow(opts.scope, opts.key);
    if (!row) {
      // Conflicted on insert but no row exists — should never happen (the
      // unique index guarantees the conflicting row is visible). Fail loudly,
      // never process without a claim.
      throw new Error(`[webhook-inbox] lost claim race for ${opts.scope}:${opts.key}`);
    }
    if (row.payloadHash !== null && row.payloadHash !== opts.payloadHash) {
      logWarn("Webhook idempotency key reused with different payload", {
        operation: "webhook.inbox.conflict",
        scope: opts.scope,
        eventId: row.id,
        status: row.status,
      });
      return { decision: "conflict", eventId: row.id };
    }
    if (row.status === "COMPLETED") {
      return { decision: "duplicate", eventId: row.id };
    }
    if (row.status === "RECEIVED" || row.status === "FAILED" || leaseExpired(row.leaseExpiresAt)) {
      if (row.status === "FAILED" || (row.status === "PROCESSING" && leaseExpired(row.leaseExpiresAt))) {
        logInfo("Webhook inbox reclaim (failed/crashed attempt)", {
          operation: "webhook.inbox.reclaim",
          scope: opts.scope,
          eventId: row.id,
          status: row.status,
          attempts: row.attempts,
        });
      }
      const claimed = await tryClaimRow(row.id, opts.payloadHash, leaseTtlSeconds);
      if (claimed) return { decision: "process", ...claimed };
      continue; // lost the row-lock race — re-read immediately.
    }
    // PROCESSING with a live lease: another worker owns it.
    if (Date.now() >= deadline) {
      const remaining = row.leaseExpiresAt
        ? Math.ceil((row.leaseExpiresAt.getTime() - Date.now()) / 1000)
        : leaseTtlSeconds;
      return {
        decision: "busy",
        eventId: row.id,
        retryAfterSeconds: Math.max(1, Math.min(30, remaining)),
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Mark a claimed delivery COMPLETED. Fenced by leaseToken: only the lease
 * holder transitions the row. Returns false when the lease was lost (a
 * reclaimer owns the row now — our processing result is orphaned and the
 * redelivery path owns the outcome; at-least-once, logged honestly).
 */
export async function completeWebhookInbox(
  eventId: string,
  leaseToken: string,
  result?: unknown,
): Promise<boolean> {
  const [row] = await db
    .update(webhookEvents)
    .set({
      status: "COMPLETED",
      result: toStorableResult(result),
      completedAt: new Date(),
      leaseExpiresAt: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(webhookEvents.id, eventId),
        eq(webhookEvents.leaseToken, leaseToken),
        eq(webhookEvents.status, "PROCESSING"),
      ),
    )
    .returning({ id: webhookEvents.id });
  if (!row) {
    logWarn("Webhook inbox completion ignored (lease not held)", {
      operation: "webhook.inbox.complete",
      eventId,
      status: "lease-lost",
    });
  }
  return Boolean(row);
}

/**
 * Mark a claimed delivery FAILED (retryable). Same lease fencing as
 * complete; the recorded message carries the AppError code when present.
 */
export async function failWebhookInbox(eventId: string, leaseToken: string, err: unknown): Promise<boolean> {
  const [row] = await db
    .update(webhookEvents)
    .set({
      status: "FAILED",
      errorMessage: toErrorMessage(err),
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(webhookEvents.id, eventId),
        eq(webhookEvents.leaseToken, leaseToken),
        eq(webhookEvents.status, "PROCESSING"),
      ),
    )
    .returning({ id: webhookEvents.id });
  if (!row) {
    logWarn("Webhook inbox failure ignored (lease not held)", {
      operation: "webhook.inbox.fail",
      eventId,
      status: "lease-lost",
    });
  }
  return Boolean(row);
}

/**
 * Delete terminal (COMPLETED/FAILED) rows older than the retention window.
 * Non-terminal rows are never pruned — a stuck PROCESSING row is evidence.
 */
export async function pruneWebhookInbox(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const rows = await db
    .delete(webhookEvents)
    .where(and(lt(webhookEvents.createdAt, cutoff), inArray(webhookEvents.status, ["COMPLETED", "FAILED"])))
    .returning({ id: webhookEvents.id });
  return rows.length;
}
