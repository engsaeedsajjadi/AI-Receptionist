import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { agentFailureReply, runAgentTurn } from "@/lib/services/agent";
import { withApiHandling } from "@/lib/server-core";

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  agentId: z.string().uuid().optional(),
  callId: z.string().uuid().optional(),
});

/**
 * Authenticated agent turn (dashboard playground / voice-loop integration).
 * Rate-limited as an AI endpoint. On LLM failure returns a safe fallback
 * reply with ok:false so callers never present fabricated success.
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "ai");
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, chatSchema);

    try {
      const result = await runAgentTurn({
        businessId: auth.businessId,
        agentId: body.agentId,
        callId: body.callId,
        userMessage: body.message,
        requestId: rid,
        actor: `user:${auth.userId}`,
      });
      return ok({ ok: true, ...result });
    } catch (err) {
      const { AppError } = await import("@/lib/errors");
      if (err instanceof AppError && err.code === "PROVIDER_NOT_CONFIGURED") {
        return ok({ ok: false, reply: agentFailureReply(), error: err.message }, 503);
      }
      throw err;
    }
  });
}
