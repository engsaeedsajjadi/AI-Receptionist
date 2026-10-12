import { requireTenantFeature } from "@/lib/tenant-config";
import { getEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";

export type AutomationEvent =
  | "new-lead"
  | "call-completed"
  | "appointment"
  | "human-handoff"
  | "notification";

export type AutomationResult = {
  ok: boolean;
  skipped?: boolean;
  /** Total HTTP attempts made (1 + retries). */
  attempts: number;
  error?: string;
};

export interface EmitOptions {
  /** Stable dedup key for this logical event. Computed once per emit and
   * shared by all retry attempts — never recomputed per attempt. */
  idempotencyKey?: string;
  requestId?: string;
  /** Override fetch in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Retries after the first attempt. Default: N8N_MAX_RETRIES (2). */
  maxRetries?: number;
  /** Base backoff between attempts (×2 per attempt). Default 500ms. */
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

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
 *   x-automation-token: N8N_WEBHOOK_SECRET (validated natively by n8n
 *     headerAuth on the Webhook node — see n8n/README.md)
 *   x-idempotency-key: <stable key, one per logical event>
 *
 * Delivery is at-least-once: network errors, 429s and 5xx responses are
 * retried with exponential backoff (all attempts share one idempotency
 * key). Critical dedup happens app-side in the automation-dispatch
 * endpoint (automation_dispatches), never in n8n static data.
 */
export async function emitAutomationEvent(
  event: AutomationEvent,
  payload: Record<string, unknown>,
  opts: EmitOptions = {},
): Promise<AutomationResult> {
  const e = getEnv();
  if (!e.N8N_ENABLED) return { ok: true, skipped: true, attempts: 0 };
  if (typeof payload.businessId === "string") await requireTenantFeature(payload.businessId, "automation");

  const maxRetries = Math.max(0, opts.maxRetries ?? e.N8N_MAX_RETRIES);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 500);
  const fetchImpl = opts.fetchImpl ?? fetch;
  // One key per emit — stable across every retry attempt.
  const idempotencyKey =
    opts.idempotencyKey ??
    `${event}:${String(payload.id ?? payload.callId ?? payload.leadId ?? "unknown")}:${Date.now()}`;
  const body = JSON.stringify({
    event,
    version: 1,
    emittedAt: new Date().toISOString(),
    idempotency_key: idempotencyKey,
    payload,
  });
  const url = `${e.N8N_URL.replace(/\/$/, "")}/webhook/ai-receptionist/${event}`;
  const started = Date.now();
  let lastError = "n8n_error";
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), e.N8N_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-automation-token": e.N8N_WEBHOOK_SECRET || "dev-webhook-secret",
          "x-idempotency-key": idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        logInfo("n8n event delivered", {
          requestId: opts.requestId,
          provider: "n8n",
          operation: `n8n.${event}`,
          status: "ok",
          durationMs: Date.now() - started,
        });
        return { ok: true, attempts };
      }
      const text = await res.text().catch(() => "");
      lastError = `n8n_http_${res.status}`;
      if (!isRetryableStatus(res.status)) {
        logError("n8n event rejected (not retryable)", {
          requestId: opts.requestId,
          provider: "n8n",
          operation: `n8n.${event}`,
          status: "error",
          durationMs: Date.now() - started,
          error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
        });
        return { ok: false, attempts, error: lastError };
      }
      logWarn("n8n event delivery failed; retrying", {
        requestId: opts.requestId,
        provider: "n8n",
        operation: `n8n.${event}`,
        status: "error",
        durationMs: Date.now() - started,
        error: `attempt ${attempts} HTTP ${res.status}: ${text.slice(0, 200)}`,
      });
    } catch (err) {
      // Network error / timeout / abort — retryable.
      lastError = err instanceof Error ? err.message : "n8n_error";
      logWarn("n8n event delivery failed; retrying", {
        requestId: opts.requestId,
        provider: "n8n",
        operation: `n8n.${event}`,
        status: "error",
        durationMs: Date.now() - started,
        error: `attempt ${attempts}: ${lastError}`.slice(0, 300),
      });
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxRetries) await sleep(baseDelayMs * 2 ** attempt);
  }

  logError("n8n event delivery exhausted retries", {
    requestId: opts.requestId,
    provider: "n8n",
    operation: `n8n.${event}`,
    status: "error",
    durationMs: Date.now() - started,
    error: `${attempts} attempts, last: ${lastError}`.slice(0, 300),
  });
  return { ok: false, attempts, error: lastError };
}
