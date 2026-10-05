import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { env, getEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { registerInboundCall } from "@/lib/services/call-admission";
import { createMediaSessionToken } from "@/lib/voice/media-auth";
import { buildInboundTwiml, buildRejectTwiml, escapeXml, TwilioVoiceProvider } from "@/lib/providers/telephony/twilio";
import { withApiHandling } from "@/lib/server-core";
import { tenantFeaturesSchema } from "@/lib/tenant-config";

/**
 * Inbound telephony webhook (Twilio Programmable Voice).
 *
 * Order: verify provider signature → resolve the tenant by the dialled number →
 * record/admit the call (idempotent, quota-reserved) → answer with TwiML that
 * greets the caller and attaches Twilio Media Streams to the media sidecar.
 *
 * Every failure path returns TwiML that explains the problem to the caller and
 * hangs up — a call is never silently dropped and never answered without
 * quota admission.
 */
function xml(body: string, status = 200) {
  return new NextResponse(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const e = getEnv();
    const raw = await req.text();
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) params[key] = value;

    if (e.VOICE_PROVIDER !== "twilio") {
      logWarn("Inbound voice webhook received while VOICE_PROVIDER is not twilio", {
        requestId: rid,
        operation: "voice.inbound",
        status: "disabled",
      });
      return xml(buildRejectTwiml("سرویس تلفنی پیکربندی نشده است."), 503);
    }

    const provider = new TwilioVoiceProvider();
    const publicUrl = `${e.APP_URL.replace(/\/$/, "")}${new URL(req.url).pathname}${new URL(req.url).search}`;
    const event = provider.parseInbound({
      params,
      signature: req.headers.get("x-twilio-signature") ?? undefined,
      signatureUrl: publicUrl,
    });

    const dialed = normalizePhone(event.To) ?? event.To;
    const [tenant] = await db
      .select({ id: businesses.id, isActive: businesses.isActive, settings: businesses.settings })
      .from(businesses)
      .where(and(eq(businesses.phone, dialed)));
    if (!tenant) {
      logWarn("Inbound call for an unknown number", {
        requestId: rid,
        operation: "voice.inbound",
        status: "unknown_number",
      });
      return xml(buildRejectTwiml("این شماره در سامانه ثبت نشده است."), 404);
    }
    if (!tenant.isActive) return xml(buildRejectTwiml("حساب کاربری غیرفعال است."), 403);
    const voiceEnabled = tenantFeaturesSchema.parse((tenant.settings as { features?: unknown }).features ?? {}).voice;
    if (!voiceEnabled) return xml(buildRejectTwiml("سرویس پاسخگویی تلفنی برای این کسبوکار فعال نیست."), 403);

    const caller = normalizePhone(event.From) ?? event.From;
    let admission: { callId: string; created: boolean };
    try {
      admission = await registerInboundCall({
        businessId: tenant.id,
        externalCallId: event.CallSid,
        phoneNumber: caller,
        direction: "INBOUND",
        metadata: { provider: "twilio", dialed, callStatus: event.CallStatus, fromCity: event.FromCity ?? null },
        idempotencyKey: `twilio:${event.CallSid}:${event.CallStatus}`,
      });
    } catch (err) {
      // Quota/feature rejections must be explained to the caller, not dropped.
      const message = err instanceof AppError ? err.message : "امکان برقراری تماس در حال حاضر وجود ندارد.";
      logWarn("Inbound call rejected during admission", {
        requestId: rid,
        businessId: tenant.id,
        operation: "voice.inbound",
        status: "rejected",
        error: err instanceof Error ? err.message : String(err),
      });
      return xml(buildRejectTwiml(message), err instanceof AppError ? err.status : 503);
    }

    if (!e.VOICE_MEDIA_PUBLIC_URL || !e.VOICE_MEDIA_TOKEN) {
      return xml(buildRejectTwiml("زیرساخت رسانهی صوتی پیکربندی نشده است."), 503);
    }

    const token = createMediaSessionToken(e.VOICE_MEDIA_TOKEN, {
      businessId: tenant.id,
      callId: admission.callId,
      externalCallId: event.CallSid,
      ttlSeconds: 120,
    });
    const settings = tenant.settings as { recording_enabled?: boolean; disclosure_message?: string; language?: string };
    const disclosure = settings.recording_enabled === false ? undefined : settings.disclosure_message;
    const twiml = buildInboundTwiml({
      websocketUrl: e.VOICE_MEDIA_PUBLIC_URL,
      token,
      businessId: tenant.id,
      callId: admission.callId,
      externalCallId: event.CallSid,
      language: e.VOICE_DEFAULT_LANGUAGE,
      disclosure: disclosure ? escapeXml(disclosure) : undefined,
    });

    logInfo("Inbound call admitted", {
      requestId: rid,
      businessId: tenant.id,
      callId: admission.callId,
      operation: "voice.inbound",
      status: admission.created ? "ok" : "duplicate",
    });
    return xml(twiml);
  });
}
