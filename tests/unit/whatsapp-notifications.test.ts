import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WhatsAppCloudProvider,
  getNotificationProvider,
  whatsAppConfigured,
} from "@/lib/providers/notifications";

/**
 * WhatsApp — Meta Cloud API adapter.
 *
 * The adapter must never report a delivery it did not get: missing credentials,
 * provider errors, and responses without a message id are all failures. When a
 * template is configured it is always used (business-initiated messages outside
 * the 24h window are otherwise rejected by Meta).
 */

const ENV_KEYS = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_TEMPLATE_NAME",
  "WHATSAPP_TEMPLATE_LANGUAGE",
  "WHATSAPP_API_VERSION",
  "WHATSAPP_TIMEOUT_MS",
] as const;

const snapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("WhatsApp Cloud provider", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("is registered for the whatsapp channel and reports configured state", () => {
    const provider = getNotificationProvider("whatsapp");
    expect(provider).toBeInstanceOf(WhatsAppCloudProvider);
    expect(provider.channel).toBe("whatsapp");
    expect(whatsAppConfigured()).toBe(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    expect(whatsAppConfigured()).toBe(true);
  });

  it("fails closed with an actionable error when credentials are missing", async () => {
    const result = await new WhatsAppCloudProvider().send({ to: "+989121112233", body: "سلام" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("WHATSAPP_ACCESS_TOKEN");
  });

  it("rejects a recipient that contains no digits", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    const result = await new WhatsAppCloudProvider().send({ to: "not-a-number", body: "سلام" });
    expect(result).toEqual({ ok: false, error: "missing_whatsapp_recipient" });
  });

  it("sends a plain text message inside the customer service window", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    const fetchMock = vi.fn(async () => jsonResponse({ messages: [{ id: "wamid.TEXT1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WhatsAppCloudProvider().send({
      to: "+98 (912) 111-2233",
      subject: "یادآوری",
      body: "نوبت بازدید شما فردا ساعت ۱۰ است.",
    });

    expect(result).toEqual({ ok: true, id: "wamid.TEXT1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/123456/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ messaging_product: "whatsapp", to: "989121112233", type: "text" });
    expect((payload.text as { body: string }).body).toContain("نوبت بازدید شما فردا ساعت ۱۰ است.");
  });

  it("always uses the approved template when one is configured", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_TEMPLATE_NAME = "appointment_reminder";
    process.env.WHATSAPP_TEMPLATE_LANGUAGE = "fa";
    const fetchMock = vi.fn(async () => jsonResponse({ messages: [{ id: "wamid.TPL1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WhatsAppCloudProvider().send({ to: "989121112233", subject: "یادآوری", body: "فردا ساعت ۱۰" });
    expect(result.ok).toBe(true);

    const payload = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      type: string;
      template: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
    };
    expect(payload.type).toBe("template");
    expect(payload.template.name).toBe("appointment_reminder");
    expect(payload.template.language.code).toBe("fa");
    expect(payload.template.components[0].parameters.map((p) => p.text)).toEqual(["یادآوری", "فردا ساعت ۱۰"]);
  });

  it("surfaces the provider error verbatim instead of reporting success", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "Message failed to send because more than 24 hours have passed", code: 131047 } }, 400),
      ),
    );

    const result = await new WhatsAppCloudProvider().send({ to: "989121112233", body: "سلام" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("whatsapp_http_400");
    expect(result.error).toContain("more than 24 hours have passed");
  });

  it("treats a 200 response without a message id as a failure", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ messaging_product: "whatsapp" })));
    const result = await new WhatsAppCloudProvider().send({ to: "989121112233", body: "سلام" });
    expect(result).toEqual({ ok: false, error: "whatsapp_response_missing_message_id" });
  });

  it("reports transport failures (abort/timeout) as failures", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    const result = await new WhatsAppCloudProvider().send({ to: "989121112233", body: "سلام" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
  });

  it("distinguishes an unparseable body from a delivered message", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway error</html>", { status: 502 })));
    const result = await new WhatsAppCloudProvider().send({ to: "989121112233", body: "سلام" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("whatsapp_http_502");
  });

  it("honours a configured API version and never falls back to an unversioned URL", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "987654";
    process.env.WHATSAPP_API_VERSION = "v22.0";
    const fetchMock = vi.fn(async () => jsonResponse({ messages: [{ id: "wamid.V22" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await new WhatsAppCloudProvider().send({ to: "989121112233", body: "سلام" });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://graph.facebook.com/v22.0/987654/messages");
  });
});
