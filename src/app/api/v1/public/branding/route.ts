import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { platformBranding, resolveBrandingByDomain } from "@/lib/services/branding";

/**
 * Public branding resolution for an edge/nginx layer or a custom-domain page.
 *
 * Unknown, suspended, non-entitled or malformed hosts all answer with the
 * platform branding and `branded:false` — the response never discloses whether a
 * domain belongs to a tenant, so this cannot be used to enumerate customers.
 * `no-store` keeps one tenant's branding out of caches shared with another.
 */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const domain = new URL(req.url).searchParams.get("domain") ?? "";
    if (!domain) return ok({ branded: false, branding: platformBranding() }, 200, { "cache-control": "no-store" });
    const resolved = await resolveBrandingByDomain(domain);
    return ok(resolved, 200, { "cache-control": "no-store" });
  });
}
