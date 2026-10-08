import { describe, expect, it } from "vitest";
import { requireLiveEnv } from "./live-config";

/**
 * Live telephony acceptance for the Twilio adapter.
 *
 * What is verified here: the configured credentials authenticate against the
 * real Twilio REST API, and (only when explicitly armed) a charged outbound
 * PSTN transport call is actually connected. This does NOT verify the inbound
 * webhook, media streaming, AI speech, or human comprehension; those remain
 * separate manual end-to-end gates.
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

  it("verifies an explicitly armed outbound PSTN connection (not the inbound AI flow)", async () => {
    // This is a charged real call. It is opt-in, and must never run on CI
    // just because provider credentials are present.
    requireLiveEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"], "telephony (Twilio)");
    const to = process.env.LIVE_TELEPHONY_CALL_TO;
    if (!to || process.env.LIVE_TELEPHONY_ACCEPT_CALL !== "yes") {
      throw new Error(
        "Live acceptance unavailable: set LIVE_TELEPHONY_CALL_TO=<E.164> and LIVE_TELEPHONY_ACCEPT_CALL=yes with the recipient's consent",
      );
    }
    if (!/^\\+[1-9]\\d{6,14}$/.test(to)) {
      throw new Error("LIVE_TELEPHONY_CALL_TO must be in E.164 format");
    }
    const from = process.env.TWILIO_PHONE_NUMBER as string;
    if (!/^\\+[1-9]\\d{6,14}$/.test(from)) {
      throw new Error("TWILIO_PHONE_NUMBER must be in E.164 format");
    }
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const api = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
    // A direct POST to /voice/twiml is invalid: that endpoint requires a signed
    // media_token. Use a self-contained TwiML greeting to test PSTN transport;
    // a separate inbound-call test is still needed for the actual assistant.
    const form = new URLSearchParams({
      To: to,
      From: from,
      Timeout: "20",
      Twiml: "<Response><Say language=\\"en-US\\">This is an authorized connectivity test of the AI receptionist telephone line.</Say><Hangup/></Response>",
    });
    const res = await fetch(`${api}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const created = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok || !created.sid) {
      throw new Error(`Live acceptance failed: could not place the call (HTTP ${res.status}, ${created.message ?? "unknown"})`);
    }
    expect(created.sid).toMatch(/^CA[0-9a-fA-F]{32}$/);

    let connected = false;
    let lastStatus = "queued";
    for (let attempt = 0; attempt < 18; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const statusRes = await fetch(`${api}/Calls/${encodeURIComponent(created.sid)}.json`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!statusRes.ok) throw new Error(`Twilio call-status lookup failed (HTTP ${statusRes.status})`);
      const status = (await statusRes.json()) as { status?: string };
      lastStatus = status.status ?? "unknown";
      if (lastStatus === "in-progress" || lastStatus === "completed") connected = true;
      if (["completed", "busy", "no-answer", "failed", "canceled"].includes(lastStatus)) break;
    }
    if (!connected) {
      throw new Error(`PSTN connection not demonstrated. Twilio call status: ${lastStatus}. Inspect call logs before retrying.`);
    }
    console.log(`[live:telephony] transportConnected=true status=${lastStatus}; inbound AI path remains unverified`);
  }, 90_000);
});
