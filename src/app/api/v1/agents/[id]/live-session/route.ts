import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { withApiHandling } from "@/lib/server-core";
import { assertIsolatedLab, requireLabAgent } from "@/lib/voice/lab-guard";
import { createLiveSession, liveReadiness } from "@/lib/voice/gemini-live";

/**
 * DEVELOPER LAB ONLY: Gemini Live (speech-to-speech) session for the local
 * telephone lab. Not Twilio/PSTN. GET reports readiness; POST mints a
 * single-use ephemeral token locked to this agent's prompt and tools.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    assertIsolatedLab();
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    await requireLabAgent(auth.businessId, id);
    return ok(liveReadiness());
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async (requestId) => {
    assertIsolatedLab();
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const agent = await requireLabAgent(auth.businessId, id);
    const grant = await createLiveSession({ businessId: auth.businessId, userId: auth.userId, agentId: agent.id }, requestId);
    return ok({ ...grant, realPhoneCall: false });
  });
}
