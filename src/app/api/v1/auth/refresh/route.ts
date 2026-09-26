import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJson } from "@/lib/api";
import { AppError } from "@/lib/errors";
import {
  REFRESH_COOKIE_NAME,
  assertSameOrigin,
  buildRefreshCookie,
  getCookieValue,
  rotateRefreshToken,
} from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";

const refreshSchema = z.object({
  refreshToken: z.string().min(10).max(4096).optional(),
});

/**
 * Refresh rotation. Accepts the refresh token from the JSON body (API
 * clients) or the HttpOnly cookie (browser clients, with same-origin
 * CSRF protection). Always rotates and re-sets the cookie.
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "refresh");
    const body = await parseJson<unknown>(req).catch(() => ({}));
    const parsed = refreshSchema.safeParse(body ?? {});
    const cookieToken = getCookieValue(req, REFRESH_COOKIE_NAME);
    const token = (parsed.success ? parsed.data.refreshToken : undefined) ?? cookieToken;
    if (!token) throw new AppError(401, "UNAUTHORIZED", "Missing refresh token");
    if (!(parsed.success && parsed.data.refreshToken) && cookieToken) {
      assertSameOrigin(req);
    }
    const tokens = await rotateRefreshToken(token);
    const res = ok(tokens);
    res.headers.set("Set-Cookie", buildRefreshCookie(tokens.refreshToken));
    return res;
  });
}
