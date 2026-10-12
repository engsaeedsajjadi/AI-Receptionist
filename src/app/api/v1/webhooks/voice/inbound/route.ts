import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { env, getEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { dialedNumberCandidates, normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { registerInboundCall } from "@/lib/services/call-admission";
import { createMediaSessionToken } from "@/lib/voice/media-auth";
import { buildInboundTwiml, buildRejectTwiml, TwilioVoiceProvider } from "@/lib/providers/telephony/twilio";
import { withApiHandling } from "@/lib/server-core";
import { tenantFeaturesSchema } from "@/lib/tenant-config";
import { tenantServingState } from "@/lib/tenant-lifecycle";

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

    const publicUrl = `${e.APP_URL.replace(/\/$/, "")}${new URL(req.url).pathname}${new URL(req.url).search}`;
    // Provider construction, signature verification and payload validation all
    // answer in TwiML: a telephony webhook must never reply with a JSON body
    // Twilio cannot render, or the caller hears nothing at all.
    let event: ReturnType<TwilioVoiceProvider["parseInbound"]>;
    try {
      const provider = new TwilioVoiceProvider();
      event = provider.parseInbound({
        params,
        signature: req.headers.get("x-twilio-signature") ?? undefined,
        signatureUrl: publicUrl,
      });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 503;
      logWarn("Inbound call rejected before admission", {
        requestId: rid,
        operation: "voice.inbound",
        status: String(status),
        error: err instanceof Error ? err.message : String(err),
      });
      const message =
        status === 401 || status === 403
          ? "امکان تأیید این تماس وجود ندارد."
          : status === 400
            ? "درخواست تماس نامعتبر است."
            : "سرویس تلفنی در دسترس نیست.";
      return xml(buildRejectTwiml(message), status);
    }

    const dialed = normalizePhone(event.To) ?? event.To;
    const candidates = dialedNumberCandidates(event.To);
    // Telephony sends E.164 while tenants may store the national form; match both
    // (bounded, index-backed) and fail closed if more than one tenant claims the
    // number — routing a call to the wrong tenant would be an isolation breach.
    const matches = await db
      .select({ id: businesses.id, isActive: businesses.isActive, status: businesses.status, settings: businesses.settings })
      .from(businesses)
      .where(and(inArray(businesses.phone, candidates), isNotNull(businesses.phone)))
      .limit(2);
    if (matches.length > 1) {
      logWarn("Inbound call matched more than one tenant", {
        requestId: rid,
        operation: "voice.inbound",
        status: "ambiguous_number",
      });
      return xml(buildRejectTwiml("مسیردهی این شماره با خطا مواجه شد."), 503);
    }
    const [tenant] = matches;
    if (!tenant) {
      logWarn("Inbound call for an unknown number", {
        requestId: rid,
        operation: "voice.inbound",
        status: "unknown_number",
      });
      return xml(buildRejectTwiml("این شماره در سامانه ثبت نشده است."), 404);
    }
    const serving = tenantServingState(tenant);
    if (!serving.serving) {
      // A tenant pending deletion or already deleted must never be answered, even
      // if `isActive` was flipped back on by an out-of-band change.
      logWarn("Inbound call for a non-serving tenant", {
        requestId: rid,
        businessId: tenant.id,
        operation: "voice.inbound",
        status: serving.reason ?? "inactive",
      });
      return xml(buildRejectTwiml("حساب کاربری غیرفعال است."), 403);
    }
    const voiceEnabled = tenantFeaturesSchema.parse((tenant.settings as { features?: unknown }).features ?? {}).voice;
    if (!voiceEnabled) return xml(buildRejectTwiml("سرویس پاسخگویی تلفنی برای این کسبوکار فعال نیست."), 403);

    if (!e.VOICE_MEDIA_PUBLIC_URL || !e.VOICE_MEDIA_TOKEN) {
      // Checked before admission: a media outage must not consume quota or leave
      // a call row behind for a caller we cannot serve.
      logWarn("Inbound call rejected: media infrastructure not configured", {
        requestId: rid,
        businessId: tenant.id,
        operation: "voice.inbound",
        status: "media_not_configured",
      });
      return xml(buildRejectTwiml("زیرساخت رسانه‌ی صوتی پیکربندی نشده است."), 503);
    }

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

    let token: string;
    try {
      token = createMediaSessionToken(e.VOICE_MEDIA_TOKEN, {
        businessId: tenant.id,
        callId: admission.callId,
        externalCallId: event.CallSid,
        ttlSeconds: 120,
      });
    } catch (err) {
      // The call is already admitted; if we cannot hand it to the media sidecar
      // the caller still gets an explanation instead of silence.
      logWarn("Inbound call could not be handed to the media sidecar", {
        requestId: rid,
        businessId: tenant.id,
        callId: admission.callId,
        operation: "voice.inbound",
        status: "media_token_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return xml(buildRejectTwiml("زیرساخت رسانه‌ی صوتی پیکربندی نشده است."), 503);
    }
    const settings = tenant.settings as { recording_enabled?: boolean; disclosure_message?: string; language?: string };
    const disclosure = settings.recording_enabled === false ? undefined : settings.disclosure_message;
    const twiml = buildInboundTwiml({
      websocketUrl: e.VOICE_MEDIA_PUBLIC_URL,
      token,
      businessId: tenant.id,
      callId: admission.callId,
      externalCallId: event.CallSid,
      language: e.VOICE_DEFAULT_LANGUAGE,
      disclosure: disclosure || undefined,
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
