import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AppError, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { getTTSProvider } from "@/lib/providers/tts";
import { meteredSpeech } from "@/lib/services/metered-ai";
import { recordUsage } from "@/lib/services/usage";
import { withApiHandling } from "@/lib/server-core";
import { assertVoiceAllowed } from "@/lib/voice/voice-safety";

const schema = z.object({
  text: z.string().trim().min(1).max(700).default("سلام، من منشی هوشمند شما هستم."),
}).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async (requestId) => {
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, schema);

    const [agent] = await db
      .select({ id: agents.id, voiceId: agents.voiceId })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId), eq(agents.isActive, true)))
      .limit(1);
    if (!agent) throw new AppError(404, "AGENT_NOT_FOUND", "Agent not found");

    await assertVoiceAllowed({ businessId: auth.businessId, voiceId: agent.voiceId });
    const result = await meteredSpeech(auth.businessId, getTTSProvider(), body.text, {
      voice: agent.voiceId,
      format: "mp3",
      requestId,
      businessId: auth.businessId,
    });
    await recordUsage({
      businessId: auth.businessId,
      type: "tts_characters",
      quantity: result.usage.characters ?? body.text.length,
      unit: "character",
      provider: result.provider,
      idempotencyKey: `voice-preview:${requestId}`,
      metadata: { agentId: agent.id, model: result.model, voice: result.voice },
    });

    return new Response(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": result.mimeType,
        "Content-Length": String(result.audio.byteLength),
        "Cache-Control": "no-store",
      },
    });
  });
}
