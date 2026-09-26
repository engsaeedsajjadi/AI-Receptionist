import { NextRequest } from "next/server";
import { ok, parseJson } from "@/lib/api";
import { revokeRefreshToken } from "@/lib/auth";
import { withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const body = await parseJson<{ refreshToken: string }>(req);
    await revokeRefreshToken(body.refreshToken);
    return ok({ ok: true });
  });
}
