import { assertTenantScope } from "@/lib/request-context";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { automationDispatches, businesses, notifications } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  getNotificationProvider,
  type NotificationChannel,
} from "@/lib/providers/notifications";
import { getEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { recordUsage } from "@/lib/services/usage";

export type NotifyInput = {
  businessId: string;
  userId?: string | null;
  type: string;
  channel?: NotificationChannel;
  title: string;
  message: string;
  recipient?: string;
  /** Idempotency: same (business, key) is delivered once. */
  idempotencyKey?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

export type NotifyResult = { id: string; delivered: boolean; duplicate: boolean };

/**
 * Idempotent, tenant-scoped notification dispatch:
 * 1. Insert PENDING row (or return existing row for the idempotency key).
 * 2. Deliver via the channel provider.
 * 3. Update row to SENT/FAILED + record usage.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  assertTenantScope(input.businessId);
  const channel: NotificationChannel = input.channel ?? getEnv().NOTIFICATION_DEFAULT_CHANNEL;

  if (input.idempotencyKey) {
    const [existing] = await db
      .select({ id: notifications.id, status: notifications.status })
      .from(notifications)
      .where(
        and(
          eq(notifications.businessId, input.businessId),
          eq(notifications.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, delivered: existing.status === "SENT", duplicate: true };
  }

  const values = {
    businessId: input.businessId,
    userId: input.userId ?? null,
    type: input.type,
    channel,
    title: input.title,
    message: input.message,
    status: "PENDING" as const,
    idempotencyKey: input.idempotencyKey ?? null,
    recipient: input.recipient ?? null,
    metadata: input.metadata ?? {},
  };

  let rowId: string;
  if (input.idempotencyKey) {
    // Race-safe: concurrent same-key inserts collapse on the unique index;
    // the loser re-selects the winner instead of 500ing.
    const [created] = await db
      .insert(notifications)
      .values(values)
      .onConflictDoNothing({ target: [notifications.businessId, notifications.idempotencyKey] })
      .returning({ id: notifications.id });
    if (created) {
      rowId = created.id;
    } else {
      const [winner] = await db
        .select({ id: notifications.id, status: notifications.status })
        .from(notifications)
        .where(
          and(
            eq(notifications.businessId, input.businessId),
            eq(notifications.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!winner) throw new Error("Notification upsert failed");
      return { id: winner.id, delivered: winner.status === "SENT", duplicate: true };
    }
  } else {
    const [created] = await db.insert(notifications).values(values).returning({ id: notifications.id });
    rowId = created.id;
  }

  // Internal channel = persisted row itself; nothing external to deliver.
  if (channel === "internal") {
    await db
      .update(notifications)
      .set({ status: "SENT", sentAt: new Date() })
      .where(eq(notifications.id, rowId));
    await recordUsage({
      businessId: input.businessId,
      type: "notifications",
      quantity: 1,
      unit: "count",
      provider: "internal",
      idempotencyKey: input.idempotencyKey ? `notify:${input.idempotencyKey}` : undefined,
      metadata: { notificationId: rowId, channel },
    });
    return { id: rowId, delivered: true, duplicate: false };
  }

  let result: { ok: boolean; error?: string };
  try {
    result = await attemptDelivery(rowId, input, channel);
  } catch (err) {
    // The provider threw instead of returning a result: record the outcome
    // as FAILED (never a stuck PENDING, never a throw to the caller).
    result = { ok: false, error: err instanceof Error ? err.message : "delivery_error" };
    await db
      .update(notifications)
      .set({ status: "FAILED", errorMessage: result.error })
      .where(eq(notifications.id, rowId));
    logWarn("Notification provider threw; recorded as FAILED", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: `notify.${channel}`,
      status: "error",
      errorCode: result.error,
    });
  }

  await recordUsage({
    businessId: input.businessId,
    type: "notifications",
    quantity: 1,
    unit: "count",
    provider: channel,
    idempotencyKey: input.idempotencyKey ? `notify:${input.idempotencyKey}` : undefined,
    metadata: { notificationId: rowId, channel, delivered: result.ok },
  });

  return { id: rowId, delivered: result.ok, duplicate: false };
}

/** One delivery attempt: provider send → SENT/FAILED row update. */
async function attemptDelivery(
  rowId: string,
  input: { businessId: string; recipient?: string; title: string; message: string; requestId?: string },
  channel: NotificationChannel,
): Promise<{ ok: boolean; error?: string }> {
  const provider = getNotificationProvider(channel);
  const result = await provider.send({
    to: input.recipient ?? "",
    subject: input.title,
    body: input.message,
    requestId: input.requestId,
    businessId: input.businessId,
  });

  await db
    .update(notifications)
    .set(
      result.ok
        ? { status: "SENT", sentAt: new Date() }
        : { status: "FAILED", errorMessage: result.error ?? "delivery_failed" },
    )
    .where(eq(notifications.id, rowId));

  if (!result.ok) {
    logWarn("Notification delivery failed", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: `notify.${channel}`,
      status: "error",
      errorCode: result.error,
    });
  }
  return result;
}

/**
 * Operator retry of a FAILED notification: FAILED → PENDING → SENT/FAILED.
 * Only FAILED rows are retryable (409 otherwise); the PENDING claim is
 * conditional so concurrent retries collapse to a single attempt.
 */
export async function retryNotification(
  businessId: string,
  notificationId: string,
  opts?: { requestId?: string },
): Promise<NotifyResult> {
  const [claimed] = await db
    .update(notifications)
    .set({ status: "PENDING", errorMessage: null })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.businessId, businessId),
        eq(notifications.status, "FAILED"),
      ),
    )
    .returning();
  if (!claimed) {
    throw new AppError(409, "CONFLICT", "Only FAILED notifications can be retried");
  }
  if (claimed.channel === "internal") {
    await db
      .update(notifications)
      .set({ status: "SENT", sentAt: new Date() })
      .where(eq(notifications.id, notificationId));
    return { id: notificationId, delivered: true, duplicate: false };
  }
  const result = await attemptDelivery(
    notificationId,
    {
      businessId,
      recipient: claimed.recipient ?? undefined,
      title: claimed.title,
      message: claimed.message,
      requestId: opts?.requestId,
    },
    claimed.channel as NotificationChannel,
  );
  return { id: notificationId, delivered: result.ok, duplicate: false };
}

/**
 * Reap notifications stuck PENDING (crash between insert and delivery):
 * they move to FAILED/auto-unconfirmed so dashboards stop showing phantom
 * in-flight rows. Operators retry explicitly via retryNotification.
 */
export async function reapStaleNotifications(
  staleAfterSeconds = 600,
  opts?: { requestId?: string; limit?: number },
): Promise<{ reaped: number }> {
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
  const stuck = await db
    .select({ id: notifications.id, businessId: notifications.businessId })
    .from(notifications)
    .where(and(eq(notifications.status, "PENDING"), lt(notifications.createdAt, cutoff)))
    .limit(opts?.limit ?? 100);
  let reaped = 0;
  for (const row of stuck) {
    const [won] = await db
      .update(notifications)
      .set({ status: "FAILED", errorMessage: "delivery_unconfirmed" })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, "PENDING")))
      .returning({ id: notifications.id });
    if (!won) continue;
    reaped++;
    logWarn("Reaped stale PENDING notification", {
      requestId: opts?.requestId,
      businessId: row.businessId,
      operation: "notify.reap",
      status: "FAILED",
    });
  }
  return { reaped };
}

// ---------------------------------------------------------------------------
// Domain event helpers (Persian copy)
// ---------------------------------------------------------------------------

export async function notifyNewLead(input: {
  businessId: string;
  leadId: string;
  customerPhone: string;
  assignedUserId?: string | null;
  requestId?: string;
}): Promise<NotifyResult> {
  assertTenantScope(input.businessId);
  return notify({
    businessId: input.businessId,
    userId: input.assignedUserId ?? null,
    type: "new_lead",
    title: "سرنخ جدید",
    message: `سرنخ جدید (${input.leadId}) با شماره ${input.customerPhone} ثبت شد.`,
    idempotencyKey: `new-lead:${input.leadId}`,
    requestId: input.requestId,
    metadata: { leadId: input.leadId },
  });
}

export async function notifyCallCompleted(input: {
  businessId: string;
  callId: string;
  phone: string;
  durationSeconds?: number | null;
  requestId?: string;
}): Promise<NotifyResult> {
  assertTenantScope(input.businessId);
  return notify({
    businessId: input.businessId,
    type: "call_completed",
    title: "پایان تماس",
    message: `تماس ${input.phone} به پایان رسید${input.durationSeconds ? ` (مدت: ${input.durationSeconds} ثانیه)` : ""}.`,
    idempotencyKey: `call-completed:${input.callId}`,
    requestId: input.requestId,
    metadata: { callId: input.callId },
  });
}

export async function notifyAppointment(input: {
  businessId: string;
  appointmentId: string;
  scheduledAt: string;
  action: "created" | "changed" | "cancelled";
  requestId?: string;
}): Promise<NotifyResult> {
  assertTenantScope(input.businessId);
  const titles = { created: "نوبت جدید", changed: "تغییر نوبت", cancelled: "لغو نوبت" } as const;
  return notify({
    businessId: input.businessId,
    type: `appointment_${input.action}`,
    title: titles[input.action],
    message: `${titles[input.action]}: ${input.scheduledAt}`,
    idempotencyKey: `appointment-${input.action}:${input.appointmentId}`,
    requestId: input.requestId,
    metadata: { appointmentId: input.appointmentId },
  });
}

export async function notifyHumanHandoff(input: {
  businessId: string;
  callId: string;
  phone: string;
  reason?: string;
  requestId?: string;
}): Promise<NotifyResult> {
  assertTenantScope(input.businessId);
  return notify({
    businessId: input.businessId,
    type: "human_handoff",
    title: "درخواست انتقال به انسان",
    message: `تماس ${input.phone} نیاز به پاسخ‌گویی انسانی دارد.${input.reason ? ` دلیل: ${input.reason}` : ""}`,
    idempotencyKey: `handoff:${input.callId}`,
    requestId: input.requestId,
    metadata: { callId: input.callId },
  });
}

export async function notifyCallbackRequested(input: {
  businessId: string;
  leadId?: string;
  phone: string;
  requestId?: string;
  /**
   * Deterministic idempotency key. Callers that retry (transfer fallback,
   * tool re-execution) MUST pass a stable key; otherwise every invocation
   * intentionally registers a distinct callback request.
   */
  idempotencyKey?: string;
}): Promise<NotifyResult> {
  return notify({
    businessId: input.businessId,
    type: "callback_requested",
    title: "درخواست تماس مجدد",
    message: `درخواست تماس مجدد برای ${input.phone} ثبت شد.`,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    metadata: { leadId: input.leadId },
  });
}

/**
 * Automation fan-out entrypoint (called by n8n workflows, served by
 * POST /api/v1/automation/dispatch).
 *
 * This table is the CRITICAL dedup store for workflow side effects:
 * INSERT … ON CONFLICT DO NOTHING on (businessId, idempotencyKey) means
 * redeliveries (emit retries, n8n replays) collapse to one notification.
 * Delivery itself reuses notify(), so PENDING/SENT/FAILED lifecycle,
 * fail-closed guards and usage recording all apply.
 */
export interface DispatchAutomationInput {
  businessId: string;
  event: string;
  channel: "email" | "sms" | "telegram" | "whatsapp";
  recipient: string;
  title?: string;
  message: string;
  idempotencyKey: string;
  requestId?: string;
}

export interface DispatchAutomationResult {
  id: string;
  duplicate: boolean;
  delivered: boolean;
  status: "PENDING" | "SENT" | "FAILED";
}

export async function dispatchAutomationEvent(
  input: DispatchAutomationInput,
): Promise<DispatchAutomationResult> {
  assertTenantScope(input.businessId);
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");

  const [inserted] = await db
    .insert(automationDispatches)
    .values({
      businessId: input.businessId,
      event: input.event,
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      recipient: input.recipient,
      title: input.title ?? input.event,
      message: input.message,
    })
    .onConflictDoNothing({
      target: [automationDispatches.businessId, automationDispatches.idempotencyKey],
    })
    .returning();

  if (!inserted) {
    const [existing] = await db
      .select()
      .from(automationDispatches)
      .where(
        and(
          eq(automationDispatches.businessId, input.businessId),
          eq(automationDispatches.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    return {
      id: existing.id,
      duplicate: true,
      delivered: existing.status === "SENT",
      status: existing.status,
    };
  }

  const outcome = await notify({
    businessId: input.businessId,
    type: `automation:${input.event}`,
    title: input.title ?? input.event,
    message: input.message,
    channel: input.channel,
    recipient: input.recipient,
    idempotencyKey: `dispatch:${input.idempotencyKey}`,
    requestId: input.requestId,
  });

  const status = outcome.delivered ? "SENT" : "FAILED";
  await db
    .update(automationDispatches)
    .set({
      status,
      attempts: 1,
      notificationId: outcome.id,
      errorMessage: outcome.delivered ? null : "delivery_failed",
      sentAt: outcome.delivered ? new Date() : null,
    })
    .where(eq(automationDispatches.id, inserted.id));

  return { id: inserted.id, duplicate: false, delivered: outcome.delivered, status };
}
