import { NextRequest } from "next/server";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { applyRetentionPolicy, privacyReport, RetentionPolicySchema, retentionPolicy, setRetentionPolicy } from "@/lib/services/data-governance";

/** Data inventory + retention policy for this tenant. */
async function authorize(req: NextRequest) {
  await checkGlobalPublicRateLimit(req);
  const auth = await getAuthContext(req);
  if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
  return auth;
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    return ok({ privacy: await privacyReport(auth.businessId), retention: await retentionPolicy(auth.businessId) });
  });
}

export async function PUT(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, RetentionPolicySchema);
    return ok({ retention: await setRetentionPolicy(auth.businessId, body) });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const auth = await authorize(req);
    const body = await parseJsonWith(req, RetentionPolicySchema);
    return ok(await applyRetentionPolicy(auth.businessId, body));
  });
}
