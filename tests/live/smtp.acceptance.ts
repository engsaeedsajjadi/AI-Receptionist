import { describe, expect, it } from "vitest";
import { requireLiveEnv } from "./live-config";

/**
 * Live SMTP acceptance: the real mailer must authenticate and accept a message
 * through the configured relay. Sends only to the explicitly designated test
 * inbox (LIVE_SMTP_TO) — never to customer addresses.
 */
describe("Live: SMTP delivery", () => {
  it("delivers a message through the configured SMTP relay", async () => {
    requireLiveEnv(["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "LIVE_SMTP_TO"], "SMTP");
    const { EmailNotificationProvider } = await import("@/lib/providers/notifications");
    const provider = new EmailNotificationProvider();
    const result = await provider.send({
      to: process.env.LIVE_SMTP_TO as string,
      subject: `[live-acceptance] منشی هوشمند ${new Date().toISOString()}`,
      body: "این پیام توسط مجموعه آزمون‌های زنده ارسال شده است. اگر آن را دریافت کردید، ارسال ایمیل واقعی تأیید می‌شود.",
      requestId: `live-smtp-${Date.now()}`,
    });
    if (!result.ok) throw new Error(`Live acceptance unavailable: SMTP rejected the message: ${result.error ?? "unknown"}`);
    expect(result.ok).toBe(true);
    expect(result.id ?? "").not.toBe("");
    console.log(`[live:smtp] accepted messageId=${result.id}`);
  }, 60_000);
});
