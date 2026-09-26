import { createHmac } from "node:crypto";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";

export type AutomationEvent =
  | "new-lead"
  | "call-completed"
  | "appointment"
  | "human-handoff"
  | "notification";

export type AutomationResult = { ok: boolean; skipped?: boolean; error?: string };

/**
 * Emit an automation event to n8n (fire-and-forget from the caller's
 * perspective: failures are logged, never thrown).
 *
 * The app remains the source of truth — n8n workflows only react
 * (notifications, CRM sync, sheets, follow-ups).
 *
 * Each workflow exposes a Webhook trigger at:
 *   POST {N8N_URL}/webhook/ai-receptionist/<event>
 * with headers:
 *   x-webhook-signature: HMAC-SHA256(N8N_WEBHOOK_SECRET, rawBody)
 *   x-idempotency-key: <event>:<entityId>:<unixSeconds>
 */
export async function emitAutomationEvent(
  event: AutomationEvent,
  payload: Record<string, unknown>,
): Promise<AutomationResult> {
  const e = getEnv();
  if (!e.N8N_ENABLED) return { ok: true, skipped: true };

  const started = Date.now();
  const body = JSON.stringify({
    event,
    version: 1,
    emittedAt: new Date().toISOString(),
    payload,
  });
  const idempotencyKey = `${event}:${String(payload.id ?? payload.callId ?? payload.leadId ?? "unknown")}:${Math.floor(Date.now() / 1000)}`;
  const signature = createHmac("sha256", e.N8N_WEBHOOK_SECRET || "dev-webhook-secret")
    .update(body, "utf8")
    .digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), e.N8N_TIMEOUT_MS);
  try {
    const res = await fetch(`${e.N8N_URL.replace(/\/$/, "")}/webhook/ai-receptionist/${event}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": signature,
        "x-idempotency-key": idempotencyKey,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logError("n8n event delivery failed", {
        provider: "n8n",
        operation: `n8n.${event}`,
        status: "error",
        durationMs: Date.now() - started,
        error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
      });
      return { ok: false, error: `n8n_http_${res.status}` };
    }
    logInfo("n8n event delivered", {
      provider: "n8n",
      operation: `n8n.${event}`,
      status: "ok",
      durationMs: Date.now() - started,
    });
    return { ok: true };
  } catch (err) {
    logError("n8n event delivery failed", {
      provider: "n8n",
      operation: `n8n.${event}`,
      status: "error",
      durationMs: Date.now() - started,
      error: err,
    });
    return { ok: false, error: err instanceof Error ? err.message : "n8n_error" };
  } finally {
    clearTimeout(timer);
  }
}
