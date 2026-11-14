import { describe, expect, it } from "vitest";
import { buildRejectTwiml } from "@/lib/providers/telephony/twilio";
import { requireLiveEnv } from "./live-config";

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Live Twilio credentials + outbound PSTN smoke only. When explicitly armed,
 * the charged outbound call must actually reach a connected state. This does
 * NOT verify inbound AI audio, real caller hearing, handoff, or persisted call
 * usage. See docs/TELEPHONY-LIVE-ACCEPTANCE.md for the required manual acceptance.
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

  it("verifies an explicitly armed, bounded outbound PSTN connection (not the inbound AI flow)", async () => {
    // This is a charged real call. It is opt-in, and must never run on CI
    // just because provider credentials are present.
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
    const api = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
    // Inline TwiML is required for a no-tenant outbound smoke: the application's
    // /voice/twiml endpoint rejects missing tenant-bound media tokens.
    const form = new URLSearchParams({
      To: to,
      From: from,
      Twiml: buildRejectTwiml("AI Receptionist telephone connection test. Goodbye.", "en-US"),
      Timeout: "15",
      TimeLimit: "30",
    });
    const res = await fetch(`${api}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    const created = (await res.json().catch(() => ({}))) as { sid?: string; status?: string };
    if (!res.ok || !created.sid) throw new Error(`Twilio outbound call creation failed (HTTP ${res.status})`);
    expect(created.sid).toMatch(/^CA[0-9a-fA-F]{32}$/);

    // Creating a call is not evidence of a connection: poll the provider status
    // until the call is answered or reaches a terminal state.
    let connected = false;
    let lastStatus = created.status ?? "queued";
    for (let attempt = 0; attempt < 18; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const statusRes = await fetch(`${api}/Calls/${encodeURIComponent(created.sid)}.json`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(20_000),
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
    console.log(`[live:telephony] transportConnected=true status=${lastStatus}`);
    console.log("[live:telephony] Caller audio, inbound AI turn, human transfer and persisted usage remain UNVERIFIED");
  }, 120_000);
});
