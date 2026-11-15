import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AppError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { runVoiceTurn } from "@/lib/voice/turn";
import { withApiHandling } from "@/lib/server-core";

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async (requestId) => {
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;

    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId), eq(agents.isActive, true)))
      .limit(1);
    if (!agent) throw new AppError(404, "AGENT_NOT_FOUND", "Agent not found");

    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) throw new AppError(400, "INVALID_PAYLOAD", "Missing audio file");
    if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "Voice test audio must be between 1 byte and 4 MiB");
    }
    const mime = (file.type || "application/octet-stream").toLowerCase().split(";")[0].trim();
    if (!ALLOWED_AUDIO_TYPES.has(mime)) {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported voice-test audio format");
    }

    const result = await runVoiceTurn({
      businessId: auth.businessId,
      agentId: id,
      audio: Buffer.from(await file.arrayBuffer()),
      audioMimeType: mime,
      requestId,
      actor: auth.userId,
      ttsFormat: "mp3",
    });

    return ok({
      heard: result.heard,
      transcript: result.transcript,
      reply: result.reply,
      spokenText: result.spokenText,
      audioBase64: result.audio ? result.audio.toString("base64") : null,
      audioMimeType: result.audioMimeType,
      latencyMs: result.latencyMs,
      usage: result.usage,
      toolCalls: result.toolCalls,
    });
  });
}
