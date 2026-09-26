# Phase 3 Final Report — Real Telephony + Persian Real-Time Voice

Branch: `arena/01a0dcc2-ai-receptionist` (commits `4dac862`..`34bdbce` + docs).
Nothing from Phases 0–2 was rebuilt: Next.js routes, Drizzle/pgvector,
Redis, multi-tenancy, RBAC, CRM, RAG, tool registry, call lifecycle,
idempotency and usage tracking are untouched in design and extended only
where Phase 3 required. No FastAPI, no second backend, no second voice
abstraction, no fake telephony, no invented provider APIs.

## A. Files Changed

New:

```text
drizzle/0004_voice_number_routing.sql (+ meta snapshot/journal)
src/lib/audio/codecs.ts          G.711 μ-law/A-law <-> PCM16
src/lib/audio/wav.ts             minimal WAV container (STT boundary)
src/lib/audio/format.ts          telephony <-> pipeline (PCM16/16k/mono) + resampler
src/lib/audio/vad.ts             energy VAD (speech-start/end, max-utterance)
src/lib/providers/capabilities.ts  Voice/STT/TTS capability contracts
src/lib/services/phone-routing.ts  called-number -> business resolver
src/lib/voice/turn-machine.ts    enforced turn state machine
src/lib/voice/session-store.ts   Redis session docs (control fields only)
src/lib/voice/speak.ts           out-of-turn Persian speech (reprompts, fallback)
tests/helpers/audio.ts           deterministic synthetic fixtures (seeded, no assets)
tests/unit/audio-codecs.test.ts
tests/unit/audio-format.test.ts
tests/unit/audio-vad.test.ts
tests/unit/provider-capabilities.test.ts
tests/unit/turn-machine.test.ts
tests/integration/phone-routing.test.ts
tests/integration/session-store.test.ts
tests/e2e/media-turn.test.ts
docs/VOICE-STAGING.md            operator runbook (§41/§42/§43/§47)
docs/PHASE3-REPORT.md            this report (§58)
```

Modified:

```text
nginx/nginx.conf                 fragment -> complete config; /media buffering off
scripts/media-server.ts          env wiring, origin allowlist, maxPayload, 1013-at-cap
src/app/api/v1/webhooks/voice/call-started/route.ts   called_number routing
src/db/schema.ts                 businesses.voice_number (unique, nullable)
src/lib/env.ts + .env.example    media caps, session timeout, VAD, silence tuning
src/lib/errors.ts                SERVER_FULL code
src/lib/providers/voice.ts       capabilities (turn-playback + WS + transfer)
src/lib/providers/stt.ts         capabilities (file, turn-only) + model in logs
src/lib/providers/tts.ts         capabilities (utterance, turn-only) + model in logs
src/lib/services/agent.ts        latencyMs {llm, tools} + agent.turn started event
src/lib/tools/registry.ts        tool started/executed logs with latency
src/lib/voice/media-server.ts    rewrite: machine, VAD mode, seq frames, silence
src/lib/voice/turn.ts            latency stage passthrough + breakdown log
tests/unit/media-server.test.ts  14 -> 28 tests
tests/integration/voice-turn.test.ts  latency-split pins
tests/e2e/call-lifecycle.test.ts + tests/e2e/redis.test.ts  fake capabilities
README.md                        voice section: routing, modes, capabilities, staging
```

## B. Architecture Changes

1. **Telephony boundary (§3–§4).** No new abstraction: `VoiceProvider` is
   extended with an explicit `capabilities` object. The generic gateway
   contract is documented and pinned: transfer ✓, streaming input ✓
   (media WS), sample-level send/duplex ✗, DTMF ✗, recording ✗,
   playback = whole-file URL or gateway-side TTS text.
2. **Tenant routing (§5–§6).** `call-started` and media `start` route by
   dialled number (`voice_number` unique, unique-`phone` fallback,
   ambiguous/unroutable fail closed, inactive never routes). An asserted
   `business_id` is accepted only when it agrees with the route.
3. **Audio layer (§8–§9).** New `src/lib/audio`: G.711 codecs, WAV,
   ingress/egress normalisation to canonical PCM16/16k/mono, linear
   resampler. Media frames: binary (opaque/legacy) + sequenced JSON
   frames (baseline, reorder window 32, duplicate drop, gap skip,
   per-frame caps, buffer caps). `ws` `maxPayload` fixed (was 100MB
   default).
4. **VAD + turn engine (§7, §10–§13, §15–§17).** Gateway-VAD mode
   (unchanged protocol) + server-VAD mode (negotiated telephony audio →
   VAD → auto turns → auto barge-in with a 1-deep pending slot).
   Enforced turn state machine on every path; Redis session docs (no
   audio in Redis, TTL-bounded); partials ack-only and provably tool-free.
5. **Out-of-turn speech (§29–§30).** Fixed Persian strings: silence
   nudges → final message → `silence-giveup` + `calls.metadata` marker →
   hangup; turn failures speak a safe fallback while technical detail
   stays server-side (`TURN_FAILED` is generic on the wire).
6. **Observability (§20, §36–§37).** Per-turn latency split
   (stt/agent/llm/tools/tts/store/total) in responses and structured
   logs; §36 events completed (barge-in, VAD, tool started/executed,
   agent started, session open/close, all with session/call/request
   identity). Metrics ride the existing pino pipeline — no new infra.
7. **Deploy (§45).** `nginx.conf` was a fragment that would crash-loop
   prod nginx (no `events`/`http` while mounted as the whole config);
   rewritten as a complete config with `/media` streaming directives.
   Boot-verification in staging still required (no docker in sandbox).

Deliberately NOT built: streaming STT/TTS adapters (providers are
file/utterance-based — a fake “streaming” label would be a lie),
sentence-chunked playback (needs gateway contract v2 + stop-playback),
DTMF, provider recording, automatic failover, new DB tables beyond
`voice_number` (existing `calls`/`callMessages`/`usageRecords` + Redis
docs cover the state).

## C. Provider

```text
Telephony provider: generic (operator gateway / protocol shim over the
                    customer's SIP trunk / PBX / cloud telephony)
STT provider:       openai (whisper-1) | compatible — file-based, turn-only
TTS provider:       openai (tts-1) | compatible — utterance-based, turn-only
LLM provider:       openai | compatible — complete(), no streaming
```

## D. Real-Time Capabilities

```text
Streaming STT:        BLOCKED (provider API is file-based; contract + fallback explicit)
Streaming TTS:        BLOCKED (provider API is utterance-based; contract explicit)
VAD:                  VERIFIED (server energy-VAD: 9 unit tests + live media tests;
                      gateway-VAD mode preserved)
Barge-in:             PARTIAL (VERIFIED: speech detection, turn supersede, pending
                      slot, auto-barge in VAD mode; BLOCKED: mid-synthesis abort —
                      impossible with utterance TTS)
Bidirectional audio:  PARTIAL (message-level full-duplex turns VERIFIED; sample-level
                      duplex honestly unsupported by the gateway contract)
```

## E. Real Phone Test

```text
Real inbound call:    BLOCKED (staging DID + gateway + keys — runbook ready)
Persian conversation: BLOCKED (same)
Property search:      BLOCKED live / VERIFIED code (real DB, e2e)
Lead:                 BLOCKED live / VERIFIED code (real DB, e2e)
Appointment:          BLOCKED live / VERIFIED code (real DB, existing e2e)
Transfer:             BLOCKED (gateway confirmation)
```

No PSTN claim is made anywhere in code, docs, or logs. `docs/VOICE-STAGING.md`
holds the 18-step procedure, the acceptance conversation, and the full
22-row matrix with per-row code/live status.

## F. Latency

No provider latency numbers exist (no provider keys in the sandbox) and
none are invented. Measured in-sandbox (stub providers — plumbing only):

- Media concurrency probe: 10 sessions × 3 turns, stub turnRunner +5ms:
  p95 turn-plumbing **< 1s** (assertion, suite-enforced), zero loss.
- E2E media journey (fake STT/TTS/LLM, REAL Postgres + Redis + tools):
  both turns complete in milliseconds of harness time; per-stage splits
  asserted ≥ 0 and plumbed end-to-end.
- First-token / first-audio splits: NOT measurable with turn-based
  providers (documented in `AgentTurnResult.latencyMs`).

Staging must collect ≥20 turns of `voice.turn` `stages` logs for real
p50/p95/max before any production claim (procedure in `VOICE-STAGING.md` §4).

## G. Tests

```text
lint:              clean (eslint .)
typecheck:         clean (tsc --noEmit)
unit:              green (incl. 27 codec/format, 9 VAD, 9 machine, 28 media, 8 capabilities)
integration:       green (routing 8, session store 2, all Phase ≤2 suites unbroken)
build:             green (next build)
voice integration: green (tests/e2e/media-turn: WS -> real turns -> real tools -> billed)
real telephony:    BLOCKED (no PSTN in sandbox/CI; explicitly not claimed)
```

Full suite: **42 files / 370 tests, 0 skipped** (Phase 2: 34/288).
Live sidecar smoke test: real boot + `/healthz` snapshot + real WS
`start` → honest `CALL_NOT_FOUND` → clean release (no strays).

## H. Remaining Blockers

1. Staging telephony: DID + gateway implementing (or shimmed to) the
   generic contract + `voice_number` per tenant.
2. Provider keys on staging: STT, TTS, LLM (Persian quality unverified
   until ears hear it).
3. Gateway media verification: 8kHz μ-law/A-law wire bytes through
   server-VAD mode, `audioUrl` fetch reachability from the gateway.
4. `nginx -t` + compose boot in staging (no docker in sandbox).
5. ≥20-turn latency sample + 1/5/10-call load observation on staging.
6. Legal/ops decisions: recording stays OFF (unsupported); silence
   callback policy reads `calls.metadata.silenceGiveup` (n8n wiring by
   operator); static media token rotation = redeploy (documented).

## I. Production Status

```text
READY FOR INTERNAL VOICE TESTING
```

The pipeline answers, routes, segments, transcribes (given keys),
reasons with real tools, speaks, interrupts, reprompts, fails safe, and
bills — all proven by 370 green tests including a live sidecar boot.
It is NOT ready for staging until blockers 1–4 close, and NOT ready for
any production until a real Persian phone call passes `VOICE-STAGING.md`
§5 with its matrix rows flipped to live-PASS on evidence.
