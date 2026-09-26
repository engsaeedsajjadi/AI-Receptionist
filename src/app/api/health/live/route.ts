import { ok } from "@/lib/api";
import { withApiHandling } from "@/lib/server-core";

export const dynamic = "force-dynamic";

/** Kubernetes-style liveness: process is running. No dependency checks. */
export async function GET() {
  return withApiHandling(async () => ok({ status: "live", timestamp: new Date().toISOString() }));
}
