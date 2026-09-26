import { NextRequest } from "next/server";
import { ok, parseJson } from "@/lib/api";
import { rotateRefreshToken } from "@/lib/auth";
import { withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const body = await parseJson<{ refreshToken: string }>(req);
    const tokens = await rotateRefreshToken(body.refreshToken);
    return ok(tokens);
  });
}
