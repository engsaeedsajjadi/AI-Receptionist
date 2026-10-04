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
  return requestContext.run({ requestId: rid, traceId: crypto.randomUUID().replaceAll("-", "") }, async () => {
    let response: Response;
    try { response = await fn(rid); }
    catch (err) { response = await handleApiError(err, rid, requestContext.getStore()); }
    response.headers.set("x-request-id", rid);
    response.headers.set("x-trace-id", requestContext.getStore()!.traceId);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}
