import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, callMessages, calls } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { normalizePhone } from "@/lib/normalization";
import { getVoiceProvider } from "@/lib/providers/voice";
import { emitAutomationEvent } from "@/lib/services/n8n";
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
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");
  return row;
}

/** Validated lifecycle transition (tenant-scoped). */
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
    .where(eq(calls.id, callId))
    .returning();
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
    .values({ callId, role: message.role, content: message.content.slice(0, 20000), metadata: message.metadata ?? {} })
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
export async function requestTransfer(
  businessId: string,
  callId: string,
  opts?: { destination?: string; reason?: string; requestId?: string },
): Promise<{ status: "TRANSFERRED" | "TRANSFER_FAILED"; destination: string | null; message: string }> {
  const call = await getCall(businessId, callId);
  const config = await getTransferConfig(businessId);
  const destination = normalizePhone(opts?.destination ?? null) ?? config.transferNumber;

  if (!destination) {
    await db
      .update(calls)
      .set({ status: "TRANSFER_FAILED" })
      .where(eq(calls.id, callId));
    await notifyHumanHandoff({
      businessId,
      callId,
      phone: call.phoneNumber,
      reason: "no transfer number configured",
      requestId: opts?.requestId,
    });
    await notifyCallbackRequested({ businessId, phone: call.phoneNumber, requestId: opts?.requestId });
    return {
      status: "TRANSFER_FAILED",
      destination: null,
      message: "متأسفانه امکان انتقال تماس در حال حاضر وجود ندارد. درخواست تماس مجدد برای شما ثبت شد.",
    };
  }

  if (!call.externalCallId) {
    throw new AppError(409, "TRANSFER_UNAVAILABLE", "Call has no telephony session to transfer");
  }

  await db
    .update(calls)
    .set({ status: "TRANSFER_REQUESTED", transferTo: destination, transferRequestedAt: new Date() })
    .where(eq(calls.id, callId));

  try {
    await db.update(calls).set({ status: "TRANSFERRING" }).where(eq(calls.id, callId));
    const result = await getVoiceProvider().transferCall(call.externalCallId, destination, {
      timeoutSeconds: config.timeoutSeconds,
      requestId: opts?.requestId,
    });
    if (!result.ok) throw new AppError(502, "TRANSFER_FAILED", "Transfer rejected by voice gateway");

    await db
      .update(calls)
      .set({ status: "TRANSFERRED", transferCompletedAt: new Date() })
      .where(eq(calls.id, callId));
    await emitAutomationEvent("human-handoff", {
      id: callId,
      businessId,
      callId,
      destination,
      status: "transferred",
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
    await db.update(calls).set({ status: "TRANSFER_FAILED" }).where(eq(calls.id, callId));
    await notifyHumanHandoff({
      businessId,
      callId,
      phone: call.phoneNumber,
      reason: err instanceof Error ? err.message : "transfer_failed",
      requestId: opts?.requestId,
    });
    await notifyCallbackRequested({ businessId, phone: call.phoneNumber, requestId: opts?.requestId });
    await emitAutomationEvent("human-handoff", {
      id: callId,
      businessId,
      callId,
      destination,
      status: "failed",
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

  const [updated] = await db
    .update(calls)
    .set({
      status: call.status === "TRANSFERRED" ? "TRANSFERRED" : "COMPLETED",
      endedAt: new Date(),
      summary,
      durationSeconds:
        call.durationSeconds ??
        (call.startedAt ? Math.max(0, Math.round((Date.now() - call.startedAt.getTime()) / 1000)) : null),
    })
    .where(eq(calls.id, callId))
    .returning();

  const { notifyCallCompleted } = await import("@/lib/services/notifications");
  await notifyCallCompleted({
    businessId,
    callId,
    phone: call.phoneNumber,
    durationSeconds: updated.durationSeconds,
    requestId: opts?.requestId,
  });
  await emitAutomationEvent("call-completed", {
    id: callId,
    businessId,
    callId,
    phone: call.phoneNumber,
    durationSeconds: updated.durationSeconds,
    summary,
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
    const result = await getLLMProvider().complete(
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
      await db.update(calls).set({ summary }).where(eq(calls.id, callId));
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
