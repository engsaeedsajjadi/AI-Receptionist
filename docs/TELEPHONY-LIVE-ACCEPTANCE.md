# Enterprise PSTN acceptance — Twilio + Persian AI receptionist

## Evidence boundary

- Browser STT/TTS and mocked Twilio Media Streams tests **do not prove** a real telephone call works.
- `npm run test:live:telephony` checks live Twilio credentials and, only when explicitly armed, initiates an outbound call with **inline TwiML**. A successful `Calls.json` response is **call creation only**: not proof a human heard audio, not inbound AI, not transfer, not persistence.
- A full incoming call must traverse: signed webhook → tenant admission/quota → public `wss://.../media` → VAD → Persian STT → agent/tools → raw PCM TTS → 8 kHz G.711 µ-law → caller → handoff/disconnect → signed call-ended settlement.
- An untested PSTN path is **BLOCKED**, not PASS.

## 1. Safe offline configuration check

Use a **staging** environment with these securely configured values:

| Setting | Required |
| --- | --- |
| `APP_URL` | Public HTTPS app origin used when checking Twilio webhook signatures |
| `VOICE_PROVIDER` | `twilio` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Active account credentials; never commit/print |
| `TWILIO_PHONE_NUMBER` | Provisioned E.164 voice number |
| `VOICE_MEDIA_PUBLIC_URL` | Public `wss://host/media`, TLS at proxy |
| `VOICE_MEDIA_TOKEN` | Random media-token signing secret, 32+ characters |
| `VOICE_MEDIA_CODEC`, `VOICE_MEDIA_SAMPLE_RATE` | `mulaw` / `8000` |
| `VOICE_VAD_ENABLED` | `true`, recommended |
| `STT_PROVIDER`, `TTS_PROVIDER` | Real providers, not `dev`; raw-PCM-capable TTS |
| Tenant config | Active tenant owning the dialed phone number, voice feature enabled; transfer number for key 0 |

Run in that environment (Node 22 can load an isolated staging env file with `--env-file`):

```bash
node scripts/telephony-preflight.mjs
```

The checker does **not** connect to Twilio, Gemini or databases and does not print secrets. `PSTN_READINESS=CONFIG_READY` checks only presence/format, **not credential validity, webhook reachability, TLS, tenant configuration or call audio**. `PSTN_READINESS=BLOCKED` exits with status 2.

## 2. Configure real inbound Twilio routing

1. Provision a Twilio number that supports inbound Voice, and set **A Call Comes In** to HTTP **POST** `https://<app-host>/api/v1/webhooks/voice/inbound`.
2. Make `APP_URL` match the exact public URL Twilio signs. The inbound handler rejects invalid `X-Twilio-Signature` before admitting a call.
3. Ensure the tenant phone is stored in a form matching the dialed number; verify tenant active status, voice feature and quotas. The handler generates short-lived per-call/tenant media tokens.
4. Start the independent media sidecar (`npm run media:server`); expose only TLS-upgraded `wss://<media-host>/media`, and monitor the private HTTP `GET /healthz` endpoint and active sessions.
5. Verify Gemini TTS returns raw PCM for telephone requests and the bridge correctly produces 8 kHz µ-law; browser audio preview alone is insufficient.
6. Configure and verify *signed* call-ended lifecycle events so usage, call status and summary settle once. A WebSocket disconnect alone is insufficient.

## 3. Optional, charged outbound PSTN smoke

`npm run test:live:telephony` has database safety gates in `tests/live/live-config.ts` / `vitest.live.config.ts`: `TEST_DATABASE_URL`, matching `DATABASE_URL`, and `LIVE_TEST_CONFIRM_RESET=yes`. Never use an operational database.

With a human ready, outbound permissions verified and billing understood, explicitly arm:

```text
LIVE_TELEPHONY_CALL_TO=+<destination-number>
LIVE_TELEPHONY_ACCEPT_CALL=yes
```

The test creates a **limited 15-second ring / 30-second-duration** outbound call that plays a short English message with inline TwiML and hangs up. It does **not** send traffic to `/voice/twiml` without a signed `media_token`. The call can incur Twilio charges. A successful API response proves only initiation; separately verify whether a person answered/heard audio in the provider console.

## 4. Required inbound Persian acceptance on a real handset

Call the Twilio number from a separate handset, using non-sensitive test phrases.

| Scenario | Required evidence |
| --- | --- |
| Answer | Twilio Call SID, signed inbound webhook, 200 TwiML, matching tenant and call IDs |
| Media | Bidirectional public WSS stream, signed `start` frame scoped to this call |
| Persian STT | Transcript matches a complete spoken Persian sentence |
| Persian TTS | Caller **hears** relevant Persian reply via 8 kHz µ-law (not only browser preview) |
| Barge-in | Interrupt a reply and verify old audio is cleared |
| Human handoff | Press 0 if configured; prove transfer target actually answers, not only INITIATED |
| Persistence | Hang up, then verify call status, transcript, summary, metered usage and idempotent settlement |
| Tenant isolation | Repeat with a second authorized tenant/number; no cross-tenant leakage |
| Performance | Record STT / agent / TTS and caller-observed round-trip latency and audio quality |

Avoid saving raw customer recordings or exposing Twilio API keys/phone numbers in reports. **GO requires** all stages observed and deployment/CI checks green; otherwise mark the unverified portion **BLOCKED**.
