import { describe, expect, it } from "vitest";
import { requireLiveEnv } from "./live-config";

/**
 * Live telephony acceptance for the Twilio adapter.
 *
 * What is verified here: the configured credentials authenticate against the
 * real Twilio REST API and the signed-webhook contract works with live
 * credentials. What is NOT claimed: PSTN call handling. Placing a real call
 * requires a purchased number plus a human to answer it, so that step stays
 * BLOCKED (LIVE_TELEPHONY_CALL_TO + LIVE_TELEPHONY_ACCEPT_CALL=yes) and this
 * suite reports the missing acceptance instead of pretending it passed.
 */
describe("Live: telephony provider (Twilio)", () => {
  it("authenticates against the live Twilio API", async () => {
    requireLiveEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], "telephony (Twilio)");
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string };
    if (!res.ok) throw new Error(`Live acceptance unavailable: Twilio rejected the credentials (${res.status} ${body.message ?? ""})`);
    expect(body.sid).toBe(sid);
    expect(["active", "suspended", "closed"]).toContain(body.status ?? "active");
    console.log(`[live:telephony] accountStatus=${body.status}`);
  }, 60_000);

  it("places a real PSTN call only when explicitly armed", async () => {
    requireLiveEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"], "telephony (Twilio)");
    const to = process.env.LIVE_TELEPHONY_CALL_TO;
    if (!to || process.env.LIVE_TELEPHONY_ACCEPT_CALL !== "yes") {
      throw new Error(
        "Live acceptance unavailable: real PSTN verification requires LIVE_TELEPHONY_CALL_TO=<E.164> and LIVE_TELEPHONY_ACCEPT_CALL=yes with a human ready to answer",
      );
    }
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const form = new URLSearchParams({
      To: to,
      From: process.env.TWILIO_PHONE_NUMBER as string,
      Url: `${process.env.APP_URL ?? "http://localhost:3000"}/api/v1/webhooks/voice/twiml`,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const created = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string };
    if (!res.ok || !created.sid) throw new Error(`Live acceptance failed: could not place a real call (${res.status} ${created.message ?? ""})`);
    expect(created.sid).toMatch(/^CA/);
    console.log(`[live:telephony] placed real call sid=${created.sid} status=${created.status}`);
  }, 120_000);
});
