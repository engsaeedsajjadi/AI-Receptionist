import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJson } from "@/lib/api";
import {
  REFRESH_COOKIE_NAME,
  assertSameOrigin,
  clearRefreshCookie,
  getCookieValue,
  revokeRefreshToken,
} from "@/lib/auth";
import { withApiHandling } from "@/lib/server-core";

const logoutSchema = z.object({
  refreshToken: z.string().min(10).max(4096).optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const body = await parseJson<unknown>(req).catch(() => ({}));
    const parsed = logoutSchema.safeParse(body ?? {});
    const cookieToken = getCookieValue(req, REFRESH_COOKIE_NAME);
    const token = (parsed.success ? parsed.data.refreshToken : undefined) ?? cookieToken;
    if (!(parsed.success && parsed.data.refreshToken) && cookieToken) {
      assertSameOrigin(req);
    }
    if (token) await revokeRefreshToken(token);
    // Always return ok (idempotent logout; avoids token-oracle behavior).
    const res = ok({ ok: true });
    res.headers.set("Set-Cookie", clearRefreshCookie());
    return res;
  });
}
