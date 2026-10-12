import nodemailer, { type Transporter } from "nodemailer";
import { AppError } from "@/lib/errors";
import { getEnv, isProduction } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";

export type NotificationChannel = "email" | "internal" | "sms" | "telegram" | "whatsapp";

export type SendNotificationInput = {
  to: string;
  subject?: string;
  body: string;
  requestId?: string;
  businessId?: string;
};

export type SendNotificationResult = {
  ok: boolean;
  id?: string;
  error?: string;
};

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  send(input: SendNotificationInput): Promise<SendNotificationResult>;
}

// ---------------------------------------------------------------------------
// Email (SMTP)
// ---------------------------------------------------------------------------

export class EmailNotificationProvider implements NotificationProvider {
  readonly channel: NotificationChannel = "email";
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    const e = getEnv();
    if (!e.SMTP_HOST || !e.SMTP_USER || !e.SMTP_PASS) {
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS required)");
    }
    this.transporter = nodemailer.createTransport({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
    return this.transporter;
  }

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    try {
      const info = await this.getTransporter().sendMail({
        from: getEnv().SMTP_FROM,
        to: input.to,
        subject: input.subject ?? "(بدون موضوع)",
        text: input.body,
      });
      logInfo("Email notification sent", {
        requestId: input.requestId,
        businessId: input.businessId,
        provider: "smtp",
        operation: "notify.email",
        status: "ok",
      });
      return { ok: true, id: String(info.messageId ?? "") || undefined };
    } catch (err) {
      logError("Email notification failed", {
        requestId: input.requestId,
        businessId: input.businessId,
        provider: "smtp",
        operation: "notify.email",
        status: "error",
        error: err,
      });
      return { ok: false, error: err instanceof Error ? err.message : "smtp_error" };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal (in-app / dashboard) — persisted by the notification service.
// This provider only validates; the service writes the DB row.
// ---------------------------------------------------------------------------

export class InternalNotificationProvider implements NotificationProvider {
  readonly channel: NotificationChannel = "internal";
  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    if (!input.to && !input.businessId) {
      return { ok: false, error: "missing_recipient" };
    }
    return { ok: true, id: `internal-${Date.now()}` };
  }
}

// ---------------------------------------------------------------------------
// SMS via generic HTTP webhook adapter (operator-configured gateway)
// ---------------------------------------------------------------------------

export class SmsWebhookProvider implements NotificationProvider {
  readonly channel: NotificationChannel = "sms";

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    const url = process.env.SMS_WEBHOOK_URL;
    if (!url) {
      return { ok: false, error: "SMS_WEBHOOK_URL is not configured" };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.SMS_API_KEY ? { Authorization: `Bearer ${process.env.SMS_API_KEY}` } : {}),
          },
          body: JSON.stringify({
            to: input.to,
            text: input.body,
            sender: process.env.SMS_SENDER ?? undefined,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { ok: false, error: `sms_gateway_http_${res.status}: ${text.slice(0, 200)}` };
        }
        return { ok: true };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "sms_error" };
    }
  }
}

// ---------------------------------------------------------------------------
// Telegram Bot API
// ---------------------------------------------------------------------------

export class TelegramNotificationProvider implements NotificationProvider {
  readonly channel: NotificationChannel = "telegram";

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };
    const chatId = input.to || process.env.TELEGRAM_DEFAULT_CHAT_ID;
    if (!chatId) return { ok: false, error: "missing_telegram_chat_id" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: input.subject ? `${input.subject}\n${input.body}` : input.body }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { ok: false, error: `telegram_http_${res.status}: ${text.slice(0, 200)}` };
        }
        return { ok: true };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "telegram_error" };
    }
  }
}

// ---------------------------------------------------------------------------
// WhatsApp — Meta Cloud API (graph.facebook.com)
//
// Sending is a two-step contract: inside the 24h customer service window a plain
// text message is accepted, outside it the provider MUST send an approved
// template. When WHATSAPP_TEMPLATE_NAME is configured we always send the
// template (the safer default for business-initiated notifications); otherwise
// we send text and surface the provider's own error verbatim instead of
// pretending delivery succeeded.
// ---------------------------------------------------------------------------

export class WhatsAppCloudProvider implements NotificationProvider {
  readonly channel: NotificationChannel = "whatsapp";

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      return { ok: false, error: "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not configured" };
    }
    // Meta expects the recipient as digits only (no '+', spaces or punctuation).
    const to = (input.to ?? "").replace(/[^0-9]/g, "");
    if (!to) return { ok: false, error: "missing_whatsapp_recipient" };

    const template = process.env.WHATSAPP_TEMPLATE_NAME ?? "";
    const body: Record<string, unknown> = template
      ? {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: template,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "fa" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: input.subject ?? "اعلان" },
                  { type: "text", text: input.body.slice(0, 900) },
                ],
              },
            ],
          },
        }
      : {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { preview_url: false, body: input.subject ? `${input.subject}\n${input.body}` : input.body },
        };

    const version = process.env.WHATSAPP_API_VERSION ?? "v21.0";
    const timeoutMs = Number(process.env.WHATSAPP_TIMEOUT_MS ?? 10_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000);
    try {
      const res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
        error?: { message?: string; code?: number };
      };
      if (!res.ok) {
        const detail = payload.error?.message ?? `http_${res.status}`;
        return { ok: false, error: `whatsapp_http_${res.status}: ${detail}` };
      }
      const messageId = payload.messages?.[0]?.id;
      if (!messageId) return { ok: false, error: "whatsapp_response_missing_message_id" };
      return { ok: true, id: messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "whatsapp_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function whatsAppConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/**
 * Console provider — TEST/DEV FIXTURES ONLY.
 * Instantiating in production throws, so it can never be selected accidentally.
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  readonly channel: NotificationChannel = "internal";
  constructor() {
    if (isProduction) {
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "ConsoleNotificationProvider is forbidden in production");
    }
  }
  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    console.log("[dev-notification]", { to: input.to, subject: input.subject, body: input.body?.slice(0, 200) });
    return { ok: true, id: `console-${Date.now()}` };
  }
}

export function getNotificationProvider(channel: NotificationChannel): NotificationProvider {
  switch (channel) {
    case "email":
      return new EmailNotificationProvider();
    case "internal":
      return new InternalNotificationProvider();
    case "sms":
      return new SmsWebhookProvider();
    case "telegram":
      return new TelegramNotificationProvider();
    case "whatsapp":
      return new WhatsAppCloudProvider();
  }
}
