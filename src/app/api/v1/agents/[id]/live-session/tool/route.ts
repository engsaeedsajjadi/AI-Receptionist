import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { withApiHandling } from "@/lib/server-core";
import { assertIsolatedLab, requireLabAgent } from "@/lib/voice/lab-guard";
import { executeLiveToolCall } from "@/lib/voice/gemini-live";

/**
 * DEVELOPER LAB ONLY: runs one function call a Gemini Live session asked for,
 * through the audited tool registry with server-side tenant context.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async (requestId) => {
    assertIsolatedLab();
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const agent = await requireLabAgent(auth.businessId, id);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new AppError(400, "INVALID_PAYLOAD", "Body must be JSON");
    }
    if (typeof body !== "object" || body === null) throw new AppError(400, "INVALID_PAYLOAD", "Body must be an object");
    const { sessionId, name, args } = body as Record<string, unknown>;
    const result = await executeLiveToolCall(
      { businessId: auth.businessId, userId: auth.userId, agentId: agent.id },
      { sessionId, name, args },
      requestId,
    );
    return ok(result);
  });
}
