import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { samlConfiguration, SamlConfigSchema, setSamlConfiguration } from "@/lib/services/identity-provisioning";
import { malwarePolicy } from "@/lib/services/identity-provisioning";

/**
 * SSO configuration for the tenant. The runtime SAML handshake stays BLOCKED
 * until an operator supplies IdP metadata; the configuration and validation are
 * fully implemented and audited.
 */
async function authorize(req: NextRequest) {
  await checkGlobalPublicRateLimit(req);
  const auth = await getAuthContext(req);
  if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
  return auth;
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    return ok({ sso: await samlConfiguration(auth.businessId), uploadScanning: malwarePolicy() });
  });
}

export async function PUT(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, SamlConfigSchema);
    return ok(await setSamlConfiguration({ userId: auth.userId, businessId: auth.businessId }, body));
  });
}
