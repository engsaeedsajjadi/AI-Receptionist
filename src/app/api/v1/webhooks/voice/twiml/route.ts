import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { getEnv, env } from "@/lib/env";
import { decodeMediaSessionToken } from "@/lib/voice/media-auth";
import { buildInboundTwiml, buildStopStreamTwiml } from "@/lib/providers/telephony/twilio";
import { withApiHandling } from "@/lib/server-core";

/**
 * TwiML endpoint the telephony adapter redirects live calls to.
 *
 * Twilio fetches this URL for every stage (answer / stream / stop). The
 * `media_token` query parameter is a signed, short-lived media session token —
 * it is verified here before any stream instructions are emitted, so an
 * attacker who guesses a CallSid cannot attach their own audio endpoint.
 */
function xml(body: string, status = 200) {
  return new NextResponse(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const url = new URL(req.url);
    const stage = url.searchParams.get("stage") ?? "answer";
    const token = url.searchParams.get("media_token") ?? "";
    const externalCallId = url.searchParams.get("external_call_id") ?? "";
    if (!token) throw new AppError(400, "INVALID_PAYLOAD", "media_token is required");
    const claims = decodeMediaSessionToken(token, getEnv().VOICE_MEDIA_TOKEN);
    if (!claims || (externalCallId && claims.externalCallId !== externalCallId)) {
      throw new AppError(401, "INVALID_SIGNATURE", "Invalid or expired media session token");
    }
    if (stage === "stop") return xml(buildStopStreamTwiml(`ai-${externalCallId}`));
    if (!claims.businessId || !claims.callId) throw new AppError(400, "INVALID_PAYLOAD", "Media token is missing call context");
    return xml(
      buildInboundTwiml({
        websocketUrl: getEnv().VOICE_MEDIA_PUBLIC_URL,
        token,
        businessId: claims.businessId,
        callId: claims.callId,
        externalCallId,
        language: getEnv().VOICE_DEFAULT_LANGUAGE,
      }),
    );
  });
}
