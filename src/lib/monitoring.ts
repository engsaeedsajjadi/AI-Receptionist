import { getEnv } from "@/lib/env";
import { redactForLog } from "@/lib/logger";

let sentryModule: typeof import("@sentry/nextjs") | null = null;
let initialized = false;

/**
 * Initialize Sentry only when SENTRY_DSN is configured.
 * Safe to call multiple times; never throws.
 */
export async function initMonitoring(): Promise<void> {
  if (initialized) return;
  initialized = true;
  let dsn = "";
  try {
    dsn = getEnv().SENTRY_DSN;
  } catch {
    return;
  }
  if (!dsn) return;
  try {
    sentryModule = await import("@sentry/nextjs");
    sentryModule.init({
      dsn,
      environment: getEnv().SENTRY_ENVIRONMENT,
      tracesSampleRate: getEnv().SENTRY_TRACES_SAMPLE_RATE,
      beforeSend(event) {
        // Strip request data that could contain secrets; keep tags/context.
        if (event.request?.headers) {
          const headers = event.request.headers as Record<string, unknown>;
          for (const key of Object.keys(headers)) {
            if (/authorization|cookie|token|secret|key/i.test(key)) headers[key] = "[REDACTED]";
          }
        }
        return event;
      },
    });
  } catch {
    sentryModule = null;
  }
}

export function captureServerError(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryModule) return;
  try {
    sentryModule.captureException(error, {
      extra: (redactForLog(context ?? {}) ?? {}) as Record<string, unknown>,
    });
  } catch {
    // monitoring must never break the request path
  }
}

export function setRequestContext(context: { requestId?: string; businessId?: string; userId?: string; callId?: string }): void {
  if (!sentryModule) return;
  try {
    sentryModule.setTag("request_id", context.requestId ?? "unknown");
    if (context.businessId) sentryModule.setTag("business_id", context.businessId);
    if (context.userId) sentryModule.setUser({ id: context.userId });
    if (context.callId) sentryModule.setTag("call_id", context.callId);
  } catch {
    // ignore
  }
}

export function isMonitoringEnabled(): boolean {
  return sentryModule !== null;
}
