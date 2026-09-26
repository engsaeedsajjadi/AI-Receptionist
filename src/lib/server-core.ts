import { NextRequest } from "next/server";
import { ApiError, error, requestId } from "@/lib/api";

const rateState = new Map<string, { count: number; resetAt: number }>();
const webhookIdempotency = new Map<string, number>();

export function checkRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const rec = rateState.get(key);
  if (!rec || rec.resetAt <= now) {
    rateState.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (rec.count >= limit) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests");
  }
  rec.count += 1;
}

export function checkGlobalPublicRateLimit(req: NextRequest) {
  checkRateLimit(`public:${req.headers.get("x-forwarded-for") ?? "ip"}`, 60, 60_000);
}

export function isWebhookReplay(idempotencyKey: string) {
  const now = Date.now();
  const existing = webhookIdempotency.get(idempotencyKey);
  if (existing && existing > now) return true;
  webhookIdempotency.set(idempotencyKey, now + 10 * 60_000);
  return false;
}

export async function withApiHandling(fn: () => Promise<Response>) {
  const rid = requestId();
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return error(err.status, err.code, err.message, rid);
    }
    return error(500, "INTERNAL_ERROR", "Unexpected server error", rid);
  }
}
