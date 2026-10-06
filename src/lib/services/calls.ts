import { meteredCompletion } from "@/lib/services/metered-ai";
import { assertTenantScope } from "@/lib/request-context";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationJobs, businesses, callMessages, calls } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { normalizePhone } from "@/lib/normalization";
import { getVoiceProvider } from "@/lib/providers/voice";
import { enqueueAutomationEvent as emitAutomationEvent, prepareAutomationEvent } from "@/lib/services/jobs";
import { enqueueOutbox } from "@/lib/services/outbox";
import { notifyCallbackRequested, notifyHumanHandoff } from "@/lib/services/notifications";

export type CallStatus = typeof calls.$inferSelect.status;

const TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  RINGING: ["CONNECTED", "ANSWERED", "IN_PROGRESS", "MISSED", "FAILED"],
  CONNECTED: ["IN_PROGRESS", "TRANSFER_REQUESTED", "COMPLETED", "FAILED"],
  ANSWERED: ["IN_PROGRESS", "TRANSFER_REQUESTED", "COMPLETED", "FAILED"],
  IN_PROGRESS: ["TRANSFER_REQUESTED", "COMPLETED", "FAILED"],
  TRANSFER_REQUESTED: ["TRANSFERRING", "TRANSFER_FAILED", "TRANSFERRED", "COMPLETED", "FAILED", "IN_PROGRESS"],
  TRANSFERRING: ["TRANSFERRED", "TRANSFER_FAILED", "COMPLETED", "FAILED"],
  TRANSFERRED: ["COMPLETED"],
  TRANSFER_FAILED: ["IN_PROGRESS", "COMPLETED", "FAILED"],
  COMPLETED: [],
  MISSED: [],
  FAILED: [],
};

export async function getCall(businessId: string, callId: string) {
  assertTenantScope(businessId);
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");
  return row;
}

/**
 * Validated lifecycle transition (tenant-scoped, race-safe).
 *
 * The write is conditional on the observed status (`WHERE id AND status`),
 * so two concurrent transitions serialize: exactly one wins and the loser
 * gets a 409 instead of silently landing the call in an invalid state.
 */
export async function transitionCall(
  businessId: string,
  callId: string,
  to: CallStatus,
  opts?: { requestId?: string },
) {
  const call = await getCall(businessId, callId);
  const allowed = TRANSITIONS[call.status] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError(409, "CONFLICT", `Invalid call transition ${call.status} → ${to}`);
  }
  const [updated] = await db
    .update(calls)
    .set({
      status: to,
      endedAt: to === "COMPLETED" || to === "FAILED" ? new Date() : undefined,
    })
    .where(and(eq(calls.id, callId), eq(calls.businessId, businessId), eq(calls.status, call.status)))
    .returning();
  if (!updated) {
    throw new AppError(409, "CONFLICT", `Call transition lost a race: ${call.status} → ${to} no longer applies`);
  }
  logInfo("Call transition", {
    requestId: opts?.requestId,
    businessId,
    callId,
    operation: "call.transition",
    status: `${call.status}->${to}`,
  });
  return updated;
}

export async function appendCallMessage(
  businessId: string,
  callId: string,
  message: { role: "CUSTOMER" | "AGENT" | "SYSTEM" | "TOOL"; content: string; metadata?: Record<string, unknown> },
) {
  await getCall(businessId, callId);
  const [row] = await db
    .insert(callMessages)
    .values({ businessId, callId, role: message.role, content: message.content.slice(0, 20000), metadata: message.metadata ?? {} })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Human handoff (transfer)
// ---------------------------------------------------------------------------

export type TransferConfig = {
  transferNumber: string | null;
  fallbackNumber: string | null;
  timeoutSeconds: number;
};

export async function getTransferConfig(businessId: string): Promise<TransferConfig> {
  assertTenantScope(businessId);
  const [biz] = await db
    .select({ settings: businesses.settings, phone: businesses.phone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!biz) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const settings = (biz.settings as Record<string, unknown>) ?? {};
  const transfer = (settings.transfer as Record<string, unknown>) ?? {};
  const transferNumber =
    normalizePhone(typeof transfer.number === "string" ? transfer.number : null) ??
    normalizePhone(biz.phone);
  const fallbackNumber = normalizePhone(typeof transfer.fallbackNumber === "string" ? transfer.fallbackNumber : null);
  const timeoutSeconds =
    typeof transfer.timeoutSeconds === "number" && transfer.timeoutSeconds > 0 && transfer.timeoutSeconds <= 120
      ? Math.floor(transfer.timeoutSeconds)
      : 30;
  return { transferNumber, fallbackNumber, timeoutSeconds };
}

/**
 * Real human-handoff flow:
 * REQUESTED → TRANSFERRING → TRANSFERRED | TRANSFER_FAILED.
 * On failure: notify operator + create callback task + honest caller message.
 * NEVER claims success when the transfer failed.
 */
/** Call states a transfer may start from (TRANSFER_FAILED allows operator retry). */
const TRANSFER_STARTABLE: CallStatus[] = ["CONNECTED", "ANSWERED", "IN_PROGRESS", "TRANSFER_FAILED"];

export async function requestTransfer(
  businessId: string,
  callId: string,
  opts?: { destination?: string; reason?: string; requestId?: string },
): Promise<{ status: "TRANSFERRED" | "TRANSFER_FAILED"; destination: string | null; message: string }> {
  const call = await getCall(businessId, callId);
  const config = await getTransferConfig(businessId);
  const destination = normalizePhone(opts?.destination ?? null) ?? config.transferNumber;

  if (!call.externalCallId) {
    throw new AppError(409, "TRANSFER_UNAVAILABLE", "Call has no telephony session to transfer");
  }
  if (!TRANSFER_STARTABLE.includes(call.status)) {
    throw new AppError(
      409,
      call.status === "TRANSFER_REQUESTED" || call.status === "TRANSFERRING"
        ? "TRANSFER_IN_PROGRESS"
        : "TRANSFER_UNAVAILABLE",
      call.status === "TRANSFER_REQUESTED" || call.status === "TRANSFERRING"
        ? "A transfer is already in progress for this call"
        : `Call is not transferable in status ${call.status}`,
    );
  }

  // Claim the transfer atomically: concurrent attempts serialize here and
  // exactly one proceeds to the voice gateway.
  const [claimed] = await db
    .update(calls)
    .set({ status: "TRANSFER_REQUESTED", transferTo: destination, transferRequestedAt: new Date() })
    .where(
      and(
        eq(calls.id, callId),
        eq(calls.businessId, businessId),
        inArray(calls.status, TRANSFER_STARTABLE),
      ),
    )
    .returning({ id: calls.id });
  if (!claimed) {
    throw new AppError(409, "TRANSFER_IN_PROGRESS", "A transfer is already in progress for this call");
  }

  if (!destination) {
    await db
      .update(calls)
      .set({ status: "TRANSFER_FAILED" })
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId), eq(calls.status, "TRANSFER_REQUESTED")));
    await notifyHumanHandoff({
      businessId,
      callId,
      phone: call.phoneNumber,
      reason: "no transfer number configured",
      requestId: opts?.requestId,
    });
    await notifyCallbackRequested({
      businessId,
      phone: call.phoneNumber,
      requestId: opts?.requestId,
      idempotencyKey: `callback:${callId}`,
    });
    return {
      status: "TRANSFER_FAILED",
      destination: null,
      message: "متأسفانه امکان انتقال تماس در حال حاضر وجود ندارد. درخواست تماس مجدد برای شما ثبت شد.",
    };
  }

  try {
    // We own the TRANSFER_REQUESTED claim; the condition below is a safety
    // net (a concurrent completion/reaper must win over a stale transfer).
    const [marking] = await db
      .update(calls)
      .set({ status: "TRANSFERRING" })
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId), eq(calls.status, "TRANSFER_REQUESTED")))
      .returning({ id: calls.id });
    if (!marking) {
      throw new AppError(409, "TRANSFER_UNAVAILABLE", "Transfer claim expired before dialing");
    }
    const result = await getVoiceProvider().transferCall(call.externalCallId, destination, {
      timeoutSeconds: config.timeoutSeconds,
      requestId: opts?.requestId,
    });
    if (!result.ok) throw new AppError(502, "TRANSFER_FAILED", "Transfer rejected by voice gateway");

    await db
      .update(calls)
      .set({ status: "TRANSFERRED", transferCompletedAt: new Date() })
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId), eq(calls.status, "TRANSFERRING")));
    await emitAutomationEvent(
      "human-handoff",
      {
        id: callId,
        businessId,
        callId,
        destination,
        status: "transferred",
      },
      { idempotencyKey: `human-handoff:${callId}:transferred` },
    );
    await db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        businessId,
        topic: "call.handoff_requested",
        idempotencyKey: `call.handoff_requested:${callId}:transferred`,
        payload: { businessId, id: callId, callId, destination, status: "transferred", phone: call.phoneNumber },
      });
    });
    logInfo("Call transferred to human", {
      requestId: opts?.requestId,
      businessId,
      callId,
      operation: "call.transfer",
      status: "TRANSFERRED",
    });
    return { status: "TRANSFERRED", destination, message: "در حال انتقال تماس به همکار ما. لطفاً منتظر بمانید." };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : "transfer_failed";
    await db
      .update(calls)
      .set({ status: "TRANSFER_FAILED" })
      .where(
        and(
          eq(calls.id, callId),
          eq(calls.businessId, businessId),
          inArray(calls.status, ["TRANSFER_REQUESTED", "TRANSFERRING"]),
        ),
      );
    await notifyHumanHandoff({
      businessId,
      callId,
      phone: call.phoneNumber,
      reason: err instanceof Error ? err.message : "transfer_failed",
      requestId: opts?.requestId,
    });
    await notifyCallbackRequested({
      businessId,
      phone: call.phoneNumber,
      requestId: opts?.requestId,
      idempotencyKey: `callback:${callId}`,
    });
    // Failed-transfer key carries the attempt instant: retries of a failed
    // transfer are distinct logical events (each attempt notifies once),
    // while retries of THIS emit share the computed key.
    const failedAt = Date.now();
    await emitAutomationEvent(
      "human-handoff",
      {
        id: callId,
        businessId,
        callId,
        destination,
        status: "failed",
      },
      { idempotencyKey: `human-handoff:${callId}:failed:${failedAt}` },
    );
    await db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        businessId,
        topic: "call.handoff_requested",
        idempotencyKey: `call.handoff_requested:${callId}:failed:${failedAt}`,
        payload: { businessId, id: callId, callId, destination, status: "failed", reason: error,
          phone: call.phoneNumber },
      });
    });
    logWarn("Call transfer failed; callback registered", {
      requestId: opts?.requestId,
      businessId,
      callId,
      operation: "call.transfer",
      status: "TRANSFER_FAILED",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "TRANSFER_FAILED",
      destination,
      message: "متأسفانه انتقال تماس ممکن نشد. درخواست پیگیری برای شما ثبت شد تا همکاران ما تماس بگیرند.",
    };
  }
}

/**
 * Reap transfers stuck mid-flight (process crash between claim and gateway
 * result): TRANSFER_REQUESTED/TRANSFERRING older than `staleAfterSeconds`
 * move to TRANSFER_FAILED with operator + callback notifications.
 * Returns the number of reaped calls. Safe to run concurrently: each row is
 * claimed with a conditional update, so exactly one reaper wins each row.
 */
export async function reapStuckTransfers(
  staleAfterSeconds = 300,
  opts?: { requestId?: string; limit?: number },
): Promise<{ reaped: number }> {
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
  const stuck = await db
    .select({ id: calls.id, businessId: calls.businessId, phoneNumber: calls.phoneNumber })
    .from(calls)
    .where(
      and(
        inArray(calls.status, ["TRANSFER_REQUESTED", "TRANSFERRING"]),
        // NULL request timestamps (manual transitions) age by row creation.
        lt(sql`COALESCE(${calls.transferRequestedAt}, ${calls.createdAt})`, cutoff),
      ),
    )
    .limit(opts?.limit ?? 100);
  let reaped = 0;
  for (const row of stuck) {
    const [won] = await db
      .update(calls)
      .set({ status: "TRANSFER_FAILED" })
      .where(
        and(
          eq(calls.id, row.id),
          inArray(calls.status, ["TRANSFER_REQUESTED", "TRANSFERRING"]),
        ),
      )
      .returning({ id: calls.id });
    if (!won) continue;
    reaped++;
    await notifyHumanHandoff({
      businessId: row.businessId,
      callId: row.id,
      phone: row.phoneNumber,
      reason: "stuck transfer reaped (no gateway result)",
      requestId: opts?.requestId,
    });
    await notifyCallbackRequested({
      businessId: row.businessId,
      phone: row.phoneNumber,
      requestId: opts?.requestId,
      idempotencyKey: `callback:${row.id}`,
    });
    logWarn("Reaped stuck transfer", {
      requestId: opts?.requestId,
      businessId: row.businessId,
      callId: row.id,
      operation: "call.transfer.reap",
      status: "TRANSFER_FAILED",
    });
  }
  return { reaped };
}

// ---------------------------------------------------------------------------
// Completion: transcript + summary + notifications + automation
// ---------------------------------------------------------------------------

export async function completeCall(
  businessId: string,
  callId: string,
  opts?: { summary?: string; requestId?: string },
) {
  const call = await getCall(businessId, callId);
  const summary = opts?.summary?.trim() || call.summary || null;

  if (call.endedAt) return call;
  const endedAt = new Date();
  const durationSeconds = call.durationSeconds ?? (call.startedAt ? Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000)) : null);
  const event = await prepareAutomationEvent("call-completed", {
    id: callId, businessId, callId, phone: call.phoneNumber, durationSeconds, summary,
  }, { idempotencyKey: `call-completed:${callId}` });
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(calls).set({
      status: call.status === "TRANSFERRED" ? "TRANSFERRED" : "COMPLETED", endedAt, summary, durationSeconds,
    }).where(and(eq(calls.id, callId), eq(calls.businessId, businessId), sql`${calls.endedAt} IS NULL`)).returning();
    if (!row) return null;
    if (event) await tx.insert(automationJobs).values(event)
      .onConflictDoNothing({ target: [automationJobs.businessId, automationJobs.idempotencyKey] });
    // Transactional outbox: external consumers (tenant webhooks, integrations)
    // see the completion event only if the completion itself committed.
    await enqueueOutbox(tx, {
      businessId,
      topic: "call.completed",
      idempotencyKey: `call.completed:${callId}`,
      payload: {
        businessId, id: callId, callId, phone: call.phoneNumber, status: row.status,
        durationSeconds: row.durationSeconds, summary, externalCallId: call.externalCallId,
        transcriptAvailable: Boolean(row.transcript),
      },
    });
    return row;
  });
  if (!updated) return getCall(businessId, callId);

  const { notifyCallCompleted } = await import("@/lib/services/notifications");
  await notifyCallCompleted({
    businessId,
    callId,
    phone: call.phoneNumber,
    durationSeconds: updated.durationSeconds,
    requestId: opts?.requestId,
  });
  return updated;
}

/**
 * Generate a Persian call summary with the LLM. Returns null (and logs) when
 * the LLM is unavailable — never fabricates a summary.
 */
export async function generateCallSummary(
  businessId: string,
  callId: string,
  opts?: { requestId?: string },
): Promise<string | null> {
  const call = await getCall(businessId, callId);
  const transcript = (call.transcript ?? "").trim();
  if (transcript.length < 20) return null;
  try {
    const { getLLMProvider } = await import("@/lib/providers/llm");
    const result = await meteredCompletion(businessId, getLLMProvider(),
      [
        {
          role: "system",
          content:
            "خلاصه‌ساز تماس تلفنی هستی. فقط بر اساس متن داده‌شده، یک خلاصه فارسی کوتاه (حداکثر ۵ جمله) بنویس: خواسته مشتری، فایل‌های مطرح‌شده، و نتیجه/اقدام بعدی. چیزی حدس نزن.",
        },
        { role: "user", content: transcript.slice(0, 12000) },
      ],
      { temperature: 0.1, maxTokens: 400, requestId: opts?.requestId, businessId, callId },
    );
    const summary = result.content?.trim() || null;
    if (summary) {
      await db.update(calls).set({ summary }).where(and(eq(calls.id, callId), eq(calls.businessId, businessId)));
      const { recordLlmUsage } = await import("@/lib/services/usage");
      await recordLlmUsage({
        businessId,
        usage: result.usage,
        provider: getLLMProvider().name,
        model: result.model,
        idempotencyKey: `summary:${callId}`,
        metadata: { callId },
      });
    }
    return summary;
  } catch (err) {
    logWarn("Call summary generation failed", {
      requestId: opts?.requestId,
      businessId,
      callId,
      operation: "call.summarize",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
