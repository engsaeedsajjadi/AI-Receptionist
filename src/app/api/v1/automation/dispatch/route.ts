import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";
import { dispatchAutomationEvent } from "@/lib/services/notifications";

const payloadSchema = z.object({
  businessId: z.string().uuid(),
  event: z.string().min(1).max(50),
  channel: z.enum(["email", "sms", "telegram", "whatsapp"]),
  recipient: z.string().min(1).max(255),
  title: z.string().max(255).optional(),
  message: z.string().min(1).max(8000),
  idempotencyKey: z.string().min(1).max(255),
});

/** Machine-to-machine auth: n8n presents N8N_API_KEY as a Bearer token. */
function verifyDispatchAuth(req: NextRequest): void {
  const apiKey = getEnv().N8N_API_KEY;
  if (!apiKey) {
    throw new AppError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Automation dispatch is not configured (N8N_API_KEY)",
    );
  }
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ", 2);
  const tokenBuf = Buffer.from(token ?? "");
  const keyBuf = Buffer.from(apiKey);
  const valid =
    scheme === "Bearer" && tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf);
  if (!valid) throw new AppError(401, "UNAUTHORIZED", "Invalid automation credentials");
}

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    verifyDispatchAuth(req);
    const body = await parseJsonWith(req, payloadSchema);
    const result = await dispatchAutomationEvent({ ...body, requestId: rid });
    return ok(result);
  });
}
