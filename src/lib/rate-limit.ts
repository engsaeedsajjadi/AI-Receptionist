import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { redisIncr } from "@/lib/redis";
import { tooManyRequests } from "@/lib/errors";

export type RateLimitPreset =
  | "login"
  | "refresh"
  | "publicWebhook"
  | "ai"
  | "upload"
  | "admin"
  | "default";

const PRESETS: Record<RateLimitPreset, { limit: number; windowSeconds: number }> = {
  login: { limit: 5, windowSeconds: 60 },
  refresh: { limit: 20, windowSeconds: 60 },
  publicWebhook: { limit: 120, windowSeconds: 60 },
  ai: { limit: 30, windowSeconds: 60 },
  upload: { limit: 10, windowSeconds: 60 },
  admin: { limit: 60, windowSeconds: 60 },
  default: { limit: 60, windowSeconds: 60 },
};

function clientIp(req: NextRequest): string {
  // X-Forwarded-For is client-controlled input: only trust it when the app
  // verifiably sits behind a proxy that sets it (TRUST_PROXY=true, e.g. the
  // production nginx). Otherwise use the direct peer address.
  if (trustProxy()) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim() || "unknown";
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

function trustProxy(): boolean {
  try {
    return getEnv().TRUST_PROXY;
  } catch {
    return process.env.TRUST_PROXY === "true";
  }
}

function windowKey(prefix: string, windowSeconds: number): string {
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  return `rl:${prefix}:${window}`;
}

/**
 * Browser E2E creates many isolated real sessions from one loopback IP.
 * Production can never use this escape hatch: both NODE_ENV and loopback host
 * are checked in addition to the explicit CI-only flag.
 */
function browserE2eBypass(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.E2E_RATE_LIMIT_BYPASS !== "true") return false;
  const host = req.nextUrl.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Redis-backed fixed-window rate limiter.
 * Throws 429 AppError (with Retry-After details) when the limit is exceeded.
 */
export async function enforceRateLimit(
  req: NextRequest,
  preset: RateLimitPreset,
  scope?: string,
): Promise<{ limit: number; remaining: number; retryAfter?: number }> {
  const { limit, windowSeconds } = PRESETS[preset];
  if (browserE2eBypass(req)) {
    return { limit, remaining: limit };
  }
  const key = windowKey(`${preset}:${scope ?? clientIp(req)}`, windowSeconds);
  const count = await redisIncr(key, windowSeconds + 5);
  if (count > limit) {
    const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    throw tooManyRequests(Math.max(retryAfter, 1));
  }
  return { limit, remaining: Math.max(limit - count, 0) };
}

/** Rate limit headers for successful responses. */
export function rateLimitHeaders(info: { limit: number; remaining: number }): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(info.limit),
    "X-RateLimit-Remaining": String(info.remaining),
  };
}
