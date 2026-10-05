import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { decodeMediaSessionToken } from "@/lib/voice/media-auth";
import { buildDialTwiml } from "@/lib/providers/telephony/twilio";
import { withApiHandling } from "@/lib/server-core";

/**
 * DTMF handler for in-call key presses.
 *
 * `0` requests a human: the digit is recorded on the call and Twilio is handed a
 * `<Dial>` TwiML that rings the tenant's transfer number. Anything else is
 * acknowledged with an empty response so the call continues.
 */
function xml(body: string) {
  return new NextResponse(body, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    const url = new URL(req.url);
    const raw = await req.text();
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
    const token = url.searchParams.get("media_token") ?? params.media_token ?? "";
    const claims = token ? decodeMediaSessionToken(token, getEnv().VOICE_MEDIA_TOKEN) : null;
    const digits = params.Digits ?? "";
    if (claims?.businessId && claims.callId) {
      const [row] = await db
        .select({ id: calls.id, metadata: calls.metadata, transferTo: calls.transferTo })
        .from(calls)
        .where(and(eq(calls.id, claims.callId), eq(calls.businessId, claims.businessId)));
      if (row) {
        const metadata = { ...row.metadata, last_dtmf: digits, dtmf_at: new Date().toISOString() };
        const transferRequested = digits.includes("0") && Boolean(row.transferTo);
        await db
          .update(calls)
          .set({
            metadata,
            ...(transferRequested ? { transferRequestedAt: new Date() } : {}),
          })
          .where(and(eq(calls.id, claims.callId), eq(calls.businessId, claims.businessId)));
        logInfo("DTMF received", {
          requestId: rid,
          businessId: claims.businessId,
          callId: claims.callId,
          operation: "voice.dtmf",
          status: transferRequested ? "handoff" : "recorded",
        });
        if (transferRequested && row.transferTo) return xml(buildDialTwiml(row.transferTo, 30));
      }
    }
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
  });
}
