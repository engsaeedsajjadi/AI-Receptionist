import { trace, SpanStatusCode } from "@opentelemetry/api";
import { metrics } from "@/lib/telemetry";
import { requestContext } from "@/lib/request-context";
import { NextRequest } from "next/server";
import { handleApiError, requestId } from "@/lib/api";
import { enforceRateLimit, type RateLimitPreset } from "@/lib/rate-limit";

/**
 * Redis-backed rate limit check (async). Prefer `enforceRateLimit` directly
 * with an explicit preset in new code.
 */
export async function checkRateLimitAsync(req: NextRequest, preset: RateLimitPreset, scope?: string) {
  return enforceRateLimit(req, preset, scope);
}

/** Default per-IP rate limit for authenticated API routes. */
export async function checkGlobalPublicRateLimit(req: NextRequest) {
  return enforceRateLimit(req, "default");
}

/**
 * Wrap a route handler with request-id + consistent error handling.
 * ApiError/AppError statuses are returned as-is; unexpected errors become
 * 500 without leaking stack traces in production.
 */
export async function withApiHandling(fn: (requestId: string) => Promise<Response>) {
  const rid = requestId();
  return trace.getTracer("ai-receptionist").startActiveSpan("api.handler", async (span) => {
  const started = performance.now();
  const actualTraceId = span.spanContext().traceId;
  return requestContext.run({ requestId: rid, traceId: /^0+$/.test(actualTraceId) ? crypto.randomUUID().replaceAll("-", "") : actualTraceId }, async () => {
    let response: Response;
    try { response = await fn(rid); }
    catch (err) { response = await handleApiError(err, rid, requestContext.getStore()); }
    response.headers.set("x-request-id", rid);
    response.headers.set("x-trace-id", requestContext.getStore()!.traceId);
    response.headers.set("Cache-Control", "no-store");
    const context = requestContext.getStore();
    span.setAttribute("http.response.status_code", response.status);
    span.setAttribute("request.id", rid);
    if (context?.businessId) span.setAttribute("tenant.id", context.businessId);
    if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    metrics().requests.inc({ status_class: `${Math.floor(response.status / 100)}xx` });
    metrics().duration.observe((performance.now() - started) / 1000);
    return response;
  }).finally(() => span.end());
  });
}
