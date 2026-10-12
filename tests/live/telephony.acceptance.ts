import { describe, expect, it } from "vitest";
import { buildRejectTwiml } from "@/lib/providers/telephony/twilio";
import { requireLiveEnv } from "./live-config";

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Live Twilio credentials + outbound PSTN smoke only. This does NOT verify
 * inbound AI audio, real caller hearing, handoff, or persisted call usage.
 * See docs/TELEPHONY-LIVE-ACCEPTANCE.md for the required manual acceptance.
 * Never point a smoke call to /voice/twiml without a signed media_token.
 */
describe("Live: telephony provider (Twilio)", () => {
  it("authenticates against the live Twilio API", async () => {
    requireLiveEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], "telephony (Twilio)");
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; status?: string };
    if (!res.ok) throw new Error(`Twilio account check failed (HTTP ${res.status})`);
    expect(body.sid).toBe(sid);
    expect(body.status).toBe("active");
    console.log("[live:telephony] accountStatus=active");
  }, 60_000);

  it("initiates a bounded outbound PSTN smoke call only when explicitly armed", async () => {
    requireLiveEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"], "telephony (Twilio)");
    const to = process.env.LIVE_TELEPHONY_CALL_TO;
    const from = process.env.TWILIO_PHONE_NUMBER as string;
    if (!to || process.env.LIVE_TELEPHONY_ACCEPT_CALL !== "yes") {
      throw new Error(
        "Live PSTN smoke test BLOCKED: set LIVE_TELEPHONY_CALL_TO=<E.164> and LIVE_TELEPHONY_ACCEPT_CALL=yes with a human ready; charges may apply",
      );
    }
    if (!E164.test(to) || !E164.test(from) || to === from) {
      throw new Error("Live PSTN smoke test BLOCKED: From and To must be distinct valid E.164 numbers");
    }
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    // Inline TwiML is required for a no-tenant outbound smoke: the application's
    // /voice/twiml endpoint rejects missing tenant-bound media tokens.
    const form = new URLSearchParams({
      To: to,
      From: from,
      Twiml: buildRejectTwiml("AI Receptionist telephone connection test. Goodbye.", "en-US"),
      Timeout: "15",
      TimeLimit: "30",
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    const created = (await res.json().catch(() => ({}))) as { sid?: string; status?: string };
    if (!res.ok || !created.sid) throw new Error(`Twilio outbound call creation failed (HTTP ${res.status})`);
    expect(created.sid).toMatch(/^CA/);
    console.log(`[live:telephony] PSTN smoke initiated; providerStatus=${created.status ?? "unknown"}`);
    console.log("[live:telephony] Caller audio, inbound AI turn, human transfer and persisted usage remain UNVERIFIED");
  }, 120_000);
});
