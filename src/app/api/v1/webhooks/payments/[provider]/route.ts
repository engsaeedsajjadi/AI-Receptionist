import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { handleProviderWebhook } from "@/lib/services/payments";
import { paymentProviderFromEnv } from "@/lib/providers/payments";

/**
 * Provider payment webhook.
 *
 * Signature-verified, replay-protected (payment_events unique on
 * provider+event id) and never trusted for amounts without a follow-up
 * `verifyPayment` call to the provider API.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ provider: string }> }) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const { provider: providerParam } = await context.params;
    const provider = paymentProviderFromEnv();
    if (!provider) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "No payment provider is configured");
    if (provider.name !== providerParam && !(providerParam === "stripe" && provider.name === "stripe")) {
      throw new AppError(404, "NOT_FOUND", "Unknown payment provider");
    }
    const rawBody = await req.text();
    const headers: Record<string, string | undefined> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const result = await handleProviderWebhook({ rawBody, headers, provider, requestId: rid });
    return ok(result);
  });
}
