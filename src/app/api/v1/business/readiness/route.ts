import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { runtimeReadiness } from "@/lib/release-readiness";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    await getAuthContext(req);
    return ok({
      ...runtimeReadiness(),
      liveAcceptance: {
        pstn: "REQUIRES_EXTERNAL_ACCEPTANCE",
        payment: "REQUIRES_EXTERNAL_ACCEPTANCE",
        smtp: "REQUIRES_EXTERNAL_ACCEPTANCE",
        oidc: "REQUIRES_EXTERNAL_ACCEPTANCE",
        storage: "REQUIRES_EXTERNAL_ACCEPTANCE",
        telemetry: "REQUIRES_EXTERNAL_ACCEPTANCE",
      },
    });
  });
}
