import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { getStorageProvider, verifyLocalSignedUrl } from "@/lib/providers/storage";
import { getEnv } from "@/lib/env";

type Ctx = { params: Promise<{ key: string[] }> };

/**
 * Capability-URL file download for the LOCAL storage provider:
 * /api/v1/files/<key>?expires=<unix>&sig=<hmac>
 * S3 deployments should use S3 pre-signed URLs directly (no route needed).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    if (getEnv().STORAGE_PROVIDER !== "local") {
      throw new ApiError(404, "NOT_FOUND", "Direct file serving is only available with local storage");
    }
    const { key } = await ctx.params;
    const objectKey = key.map((seg) => decodeURIComponent(seg)).join("/");
    const expires = req.nextUrl.searchParams.get("expires") ?? "";
    const sig = req.nextUrl.searchParams.get("sig") ?? "";
    if (!verifyLocalSignedUrl(objectKey, expires, sig)) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid or expired file URL");
    }
    const data = await getStorageProvider().download(objectKey);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
        "Cache-Control": "private, max-age=300",
      },
    });
  });
}
