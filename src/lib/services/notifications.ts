import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
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

  const [row] = await db
    .insert(notifications)
    .values({
      businessId: input.businessId,
      userId: input.userId ?? null,
      type: input.type,
      channel,
      title: input.title,
      message: input.message,
      status: "PENDING",
      idempotencyKey: input.idempotencyKey ?? null,
      recipient: input.recipient ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: notifications.id });

  // Internal channel = persisted row itself; nothing external to deliver.
  if (channel === "internal") {
    await db
      .update(notifications)
      .set({ status: "SENT", sentAt: new Date() })
      .where(eq(notifications.id, row.id));
    await recordUsage({
      businessId: input.businessId,
      type: "notifications",
      quantity: 1,
      unit: "count",
      provider: "internal",
      idempotencyKey: input.idempotencyKey ? `notify:${input.idempotencyKey}` : undefined,
      metadata: { notificationId: row.id, channel },
    });
    return { id: row.id, delivered: true, duplicate: false };
  }

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
    .where(eq(notifications.id, row.id));

  if (!result.ok) {
    logWarn("Notification delivery failed", {
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
    metadata: { notificationId: row.id, channel, delivered: result.ok },
  });

  return { id: row.id, delivered: result.ok, duplicate: false };
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
}): Promise<NotifyResult> {
  return notify({
    businessId: input.businessId,
    type: "callback_requested",
    title: "درخواست تماس مجدد",
    message: `درخواست تماس مجدد برای ${input.phone} ثبت شد.`,
    idempotencyKey: `callback:${input.leadId ?? input.phone}:${Date.now()}`,
    requestId: input.requestId,
    metadata: { leadId: input.leadId },
  });
}
