# Voice Staging Guide — Real Telephony + Persian Real-Time Voice (Phase 3)

This is the operator runbook for putting a REAL phone call through the AI
Receptionist on staging. It documents the selected provider model (the
`generic` telephony gateway), every credential and URL, the step-by-step
procedure, and the acceptance matrix. Nothing here is verified without an
actual call — credential-dependent checks are marked BLOCKED until staging
runs them.

## 1. Architecture (as built)

```text
PSTN / SIP phone
      ↓ (operator's trunk / PBX / cloud telephony)
Generic telephony gateway  ←── YOU point the app at this box
   │  REST: answer / hangup / play / transfer / stream / status
   │  Webhooks → app  (HMAC-signed)
   └── Media WebSocket → sidecar  (token auth, optional origin allowlist)
          ↓
Media sidecar (scripts/media-server.ts, wss://<host>/media)
   │  start (tenant bind) → audio → utterance → agent-audio …
   └── server-vad mode: 8kHz μ-law/A-law → PCM16 → VAD → auto turns
          ↓
App: STT (Persian) → agent + audited tools → TTS (Persian) → playback
```

The app never speaks vendor protocols directly. `VOICE_PROVIDER=generic`
is a thin HTTP adapter (`src/lib/providers/voice.ts`); the operator's
gateway (or a small protocol shim in front of a SIP trunk / PBX) implements
the contract below. Capabilities are explicit
(`src/lib/providers/capabilities.ts`): turn-playback + WS media input +
transfer. DTMF, provider recording and sample-level duplex audio are
honestly unsupported — do not rely on them.

## 2. Generic gateway contract (implement/verify against THIS)

Base URL: `VOICE_API_BASE_URL`, auth `Authorization: Bearer VOICE_API_KEY`,
JSON everywhere, 15s timeout, 2 retries on network faults.

| App → gateway | Purpose |
|---|---|
| `POST /calls/{id}/answer` | Answer the ringing call |
| `POST /calls/{id}/hangup` `{reason?}` | Hang up |
| `POST /calls/{id}/play` `{audioUrl?, text?, language?}` | Play reply audio (URL preferred; `text` = gateway-side TTS fallback, Persian) |
| `POST /calls/{id}/transfer` `{destination, timeoutSeconds?, idempotencyKey?}` | Transfer to human; response `{status}` (`completed` ⇒ TRANSFERRED, else INITIATED; HTTP error ⇒ TRANSFER_FAILED). Gateways SHOULD dedup retries carrying the same `idempotencyKey` (the app re-issues with a stable key when recovering a crashed transfer; gateways that ignore it keep at-least-once behavior across that window only) |
| `POST /calls/{id}/stream/start` `{websocketUrl, language?, mediaToken}` | Open media WS to the sidecar; forward `mediaToken` verbatim as `token` in the `start` frame |
| `POST /calls/{id}/stream/stop` | Close media streaming |
| `GET /calls/{id}` → `{status, ...}` | Poll call status |

Gateway → app webhooks (`https://<host>/api/v1/webhooks/voice/*`):

| Event | Body (JSON) |
|---|---|
| `call-started` | `{business_id?|called_number?, external_call_id, phone_number, agent_id?, direction?, metadata?}` — at least one of `business_id`/`called_number`; both must agree |
| `audio` | multipart (`audio` file + `business_id`, `external_call_id`, `event_id?`, `is_final?`) or JSON (`transcript` + `is_final`) — `is_final=false` only acks, NEVER runs tools |
| `transcript` | gateway-STT topology turns |
| `tool-call` | gateway-initiated tool execution |
| `call-ended` | `{business_id, external_call_id, duration_seconds?, status?}` → completion chain |

Webhook security (all events): byte-exact body, HMAC-SHA256 with
`VOICE_WEBHOOK_SECRET`, header `x-webhook-signature` (also accepts
`x-signature`, `x-hub-signature-256` with optional `sha256=` prefix, or
Stripe-style `t=<ts>,v1=<hex>` signing `<ts>.<raw-bytes>`), required
`x-idempotency-key` (24h Redis dedup window), optional
`x-webhook-timestamp`/`x-timestamp` checked against a ±5 min window
(`STALE_TIMESTAMP` outside it). Max body enforced; invalid payloads never
burn idempotency keys.

Media WebSocket (`VOICE_MEDIA_PUBLIC_URL`, e.g. `wss://<host>/media`,
nginx `/media` → `media:3001`, buffering off, 1d timeouts): full frame
reference in `src/lib/voice/media-server.ts` header. Essentials for the
gateway implementer:

- First frame MUST be `start` with `token` = the per-call `mediaToken`
  from `stream/start` (HMAC-signed, single call+tenant, TTL
  `VOICE_MEDIA_TOKEN_TTL_SECONDS`, default 900s; legacy static
  `VOICE_MEDIA_TOKEN` still accepted during gateway upgrades — it MUST
  NOT start with `v1.`). The token fixes tenant+call: asserted
  `businessId`/`callId`/`calledNumber` are optional and MUST agree with
  it (mismatch ⇒ fatal `TENANT_MISMATCH`/`CALL_MISMATCH`). The app never
  sends `VOICE_MEDIA_TOKEN` itself anywhere — rotate it after upgrading
  the gateway; never log or persist media tokens.
- Gateway-VAD mode (default): binary audio chunks (opaque bytes for STT
  upload) or `{type:"audio", seq, payload}` sequenced frames, then
  `{type:"utterance-end", eventId}` per utterance. One turn at a time.
- Server-VAD mode: `start` with `utteranceMode:"server-vad"` +
  `audio:{encoding: pcm16|mulaw|alaw, sampleRate: 8000|16000}`; the server
  segments speech (tune `VOICE_VAD_*`), emits `vad` events, auto-runs
  turns, and auto-barges when the caller talks over the agent.
- Server replies `agent-audio` (inline base64 ≤2MB else `audioUrl` for the
  gateway to fetch) + `turn-complete` with `latencyMs`/`usage`.
- `barge-in` from the gateway discards the in-flight turn
  (`turn-superseded`); partial text (`isFinal:false`) only gets
  `partial-ack` and NEVER triggers tools.
- Silence: after `VOICE_SILENCE_TIMEOUT_MS` the server speaks Persian
  nudges (`VOICE_SILENCE_MAX_REPROMPTS`), then a final message +
  `silence-giveup` and closes; the call row is marked
  (`calls.metadata.silenceGiveup`) for callback automation.

## 3. Staging checklist (credentials + config)

- [ ] `VOICE_PROVIDER=generic`, `VOICE_API_BASE_URL`, `VOICE_API_KEY`
- [ ] `VOICE_WEBHOOK_SECRET` (strong random; same value in the gateway)
- [ ] `VOICE_MEDIA_PUBLIC_URL=wss://<staging-host>/media`, `VOICE_MEDIA_TOKEN`
      (signing secret; per-call tokens minted from it, TTL
      `VOICE_MEDIA_TOKEN_TTL_SECONDS`, default 900s)
- [ ] `VOICE_MEDIA_ALLOWED_ORIGINS` (gateway origin, recommended)
- [ ] `STT_PROVIDER=openai|compatible` + key/URL, `STT_MODEL`
- [ ] `TTS_PROVIDER=openai|compatible` + key/URL, `TTS_MODEL`, `TTS_VOICE`
- [ ] `LLM_PROVIDER=openai|compatible` + key/URL, `LLM_MODEL`
- [ ] Per-tenant `businesses.voice_number` set to the staged DID (E.164 or
      national; any of `09…`/`+98…`/`0098…`/Persian digits routes identically)
- [ ] Public HTTPS reachable by the gateway; `nginx -t` passed in staging
- [ ] `npm run db:migrate` applied (includes `voice_number`, unique index)

## 4. Staging procedure (§41)

1. Configure a real phone number (DID) on the gateway for the business.
2. Set the tenant's `voice_number` to that DID.
3. Point gateway webhooks at `https://<host>/api/v1/webhooks/voice/*`.
4. Point media streaming at `VOICE_MEDIA_PUBLIC_URL`.
5. Configure STT credentials; 6. TTS credentials; 7. LLM credentials.
6. Start the app + sidecar (`docker compose up`, health `/healthz`).
7. Call the DID from a real phone; speak Persian.
8. Verify the transcript ( Persian, raw preserved) in logs/`callMessages`.
9. Verify the LLM response is natural Persian (no JSON/URLs/IDs spoken).
10. Verify a property search hits real DB rows.
11. Verify lead creation (row + deduped customer).
12. Verify an appointment (availability checked BEFORE confirming).
13. Verify TTS audio is heard by the caller, promptly.
14. Verify human transfer (provider-confirmed; failure ⇒ callback offer).
15. Verify call completion (transcript + summary + usage + notification + n8n).

Collect latencies from the `voice.turn` completion logs (`stages` block)
and the `turn-complete` frames; compute p50/p95/max per stage over ≥20
turns before any production claim.

## 5. Acceptance conversation (§42)

```text
Caller: سلام، دنبال آپارتمان دو خوابه در سعادت‌آباد هستم.
AI:     حتماً. بودجه حدودی شما چقدره؟            (real turn, no tools yet)
Caller: تا پنج میلیارد.
AI:     [real property search → spoken shortlist]  (DB rows only)
Caller: یکی از گزینه‌ها رو می‌خوام فردا ببینم.
AI:     [real availability check]                  (before confirming)
Caller: ساعت پنج خوبه.
AI:     [real appointment creation → spoken confirmation]
Caller: اگر ممکنه با کارشناس هم صحبت کنم.
AI:     [real transfer → provider-confirmed handoff]
```

Every step must be backed by actual system state (rows, usage, provider
confirmations) — never by scripted replies.

## 6. Acceptance matrix (§43) — current status

| Test | Status |
|---|---|
| Real inbound call | BLOCKED (staging DID + gateway) |
| Phone → business routing | PASS (code) / BLOCKED (live) |
| Webhook verification | PASS (HMAC + idempotency tested) |
| Media WebSocket | PASS (code + live sidecar smoke) / BLOCKED (gateway media) |
| Audio codec | PASS (G.711 round-trips tested) |
| Persian STT | BLOCKED (provider key) |
| Partial transcript | PASS (code: ack-only, tool-free) |
| Final transcript | BLOCKED (provider key) |
| LLM | BLOCKED (provider key) |
| Tool calling | PASS (code: registry + audit) |
| Property search | PASS (code, real DB) / BLOCKED (live speech) |
| Lead creation | PASS (code, real DB) / BLOCKED (live speech) |
| Appointment | PASS (code, real DB) / BLOCKED (live speech) |
| Persian TTS | BLOCKED (provider key) |
| Caller hears audio | BLOCKED (live call) |
| Barge-in | PASS (code: turn-supersede + VAD auto) / BLOCKED (live) |
| Human transfer | PASS (code: claim machine) / BLOCKED (gateway confirm) |
| Call completion | PASS (code) |
| Transcript persistence | PASS (code, real DB) |
| Summary | PASS (code) / BLOCKED (LLM key for live quality) |
| Usage | PASS (code: idempotent metering) |
| n8n automation | PASS (code: dispatch + stamp) |

“PASS (code)” = implemented + covered by the automated suite with
provider fakes ONLY at the boundary (suite runs green in CI with real
Postgres + Redis). Anything requiring a provider key, a gateway, or ears
is BLOCKED until §4 runs on staging. No row is marked live-PASS without
a real call.

## 7. Failure modes + troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| `INVALID_SIGNATURE` | secret mismatch / body rewritten by proxy | gateway signer, `VOICE_WEBHOOK_SECRET` |
| `STALE_TIMESTAMP` | clock skew > 5 min | NTP on gateway |
| 404 on `call-started` | `voice_number` unset / typo | tenant config, routing logs |
| 409 on `call-started` | DID shared by 2 tenants | `voice_number` uniqueness |
| `CALL_NOT_FOUND` on WS start | `call-started` never arrived / wrong id | webhook delivery order |
| `BUFFER_OVERFLOW` | gateway never sends `utterance-end` | gateway VAD / switch to server-vad |
| `turn-superseded` always | gateway sends `barge-in` spuriously | gateway endpointing |
| Silence giveups | one-way audio (gateway NAT/firewall) | RTP/WS audio path, `VOICE_VAD_*` |
| `TURN_FAILED` + fallback heard | STT/LLM/TTS outage | provider status, server logs (detail stays server-side) |
| No audio heard | `audioUrl` unreachable from gateway | storage signed-URL reachability / `play` with `text` fallback |
| `SERVER_FULL` / 1013 | sidecar at `VOICE_MAX_CONCURRENT_SESSIONS` | scale sidecar / raise cap |

Latency triage: `stt` high ⇒ audio too long / STT region; `llm` high ⇒
model/region; `tools` high ⇒ DB slowness (check indexes); `tts` high ⇒
reply too long (cleaner caps at 2000 chars) / TTS region.
