import { NextRequest } from "next/server";
import { ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { searchProperties } from "@/lib/services/properties";

/**
 * Tool-compatible property search (tenant-scoped, Persian-normalized).
 * The AI may ONLY mention properties returned here.
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const body = await parseJson<Record<string, unknown>>(req);
    const results = await searchProperties(auth.businessId, body);
    return ok({ properties: results });
  });
}
