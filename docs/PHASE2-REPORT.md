# Phase 2 Final Report — Hardening in place (no rewrite)

The Phase 1 stack (Next.js API routes + Drizzle + Postgres/pgvector + Redis +
n8n) was kept. No second backend was introduced. Nothing below is claimed from
interfaces, env flags, or mocks alone: every item was verified end-to-end
(config → provider → service → API → DB → errors → tests → real execution),
and anything unverifiable from the sandbox is marked Blocked, not complete.

Commit map: `4418abf` (Phases B–E consolidated) → `d378459` (F) →
`cf800f0` (G) → `e23b07b` (H) → `34a1eb3` (I).

## Implemented

- **Voice pipeline (provider-abstracted):** HMAC-signed webhooks
  (`call-started/audio/transcript/tool-call/call-ended`, byte-exact signatures,
  ±5 min window, DB-backed idempotency), `call-started` ON CONFLICT
  concurrency safety, transcript `event_id` dedup with advisory locks,
  `turn.ts` audio→STT→agent→TTS with archived audio for gateway playback.
- **Bidirectional media:** sidecar (`scripts/media-server.ts`, `src/lib/voice`)
  with per-call token auth, barge-in, tenant-scoped call resolution; nginx
  `/media` route; plain-HTTP-upgrade smoke verified (101 pre-auth).
- **Persian STT/TTS + normalization:** provider abstraction
  (`openai`/`compatible`/env-gated `dev`), Persian-first prompts, ي/ک/digit
  normalization before all downstream processing; dev providers fail honestly
  with `PROVIDER_NOT_CONFIGURED` (prod env validation rejects all `dev`
  providers at boot — verified by boot refusal test).
- **LLM via tool registry only:** 10 audited tools with tenant context, schema
  validation, `businessId` stripping from model args; providers and the voice
  turn import zero `@/db` modules (verified by grep: exit 1).
- **Guardrails + RAG/property separation:** `src/lib/guardrails.ts` prompts,
  `search_knowledge` (hybrid vector+trigram, RRF k=60 — the documented
  constant matches the code) vs `search_properties` (structured filters);
  the AI may only mention tool-returned properties.
- **n8n without static-data dedup:** emit has exp-backoff retries
  (network/429/5xx, `N8N_MAX_RETRIES`) sharing one stable idempotency key per
  emit; workflows are Webhook(headerAuth)→Prepare→Dispatch→Respond with no
  static data, no HMAC theater, no provider secrets; critical dedup is
  `automation_dispatches` + `POST /api/v1/automation/dispatch` (`N8N_API_KEY`
  Bearer). Topology pinned by 26 structural tests.
- **Notification lifecycle:** PENDING/SENT/FAILED with send-guard
  (throwing provider → recorded FAILED), `retryNotification` (FAILED-only,
  collapsing), stale-PENDING reaper.
- **Handoff state machine:** table-validated conditional transitions,
  claim-based `requestTransfer` (`TRANSFER_IN_PROGRESS` vs
  `TRANSFER_UNAVAILABLE`), stuck-transfer reaper, no wedged states.
- **Maintenance wiring:** `runMaintenance()` + ADMIN route + `npm run
  maintenance` cron script (verified live: seeded rows reaped 1/1).
- **Appointments:** Asia/Tehran-first (business timezone, Intl-based),
  working-hours/holidays/buffers, transactional overlap prevention,
  distributed anti-double-booking locks, same-tenant FK validation.
- **Tenancy:** all 41 DB access sites audited — every tenant read/write is
  business-scoped; agent `callId`, appointment refs, assignees, and tool
  userIds are membership-checked (404s leak nothing cross-tenant).
- **RBAC:** ADMIN/MANAGER/AGENT with a verified per-route matrix (README),
  last-admin protection, unique-race 409s (register + user-create),
  honest account-lockout test (distributed-IP shape + DB mechanism proof).
- **Security/storage/usage/observability:** secret redaction (2 layers,
  pinned incl. real log capture), timing-safe compares, rate limits on all
  routes but `/live`, security headers (live-verified), signed capability
  file URLs with tenant-scoped keys, USD cost estimates from a
  web-verified pricing table, request-id logging.
- **CI/DB/ops:** CI provisions Postgres+pgvector+Redis; the result checker
  fails on skips/hollow runs (verified both directions); migrations 0000–0003
  apply cleanly; prod compose + nginx + TLS + backup/restore scripts exist.

## Partial

- **Persian eval:** unit-level coverage only (normalization, extraction,
  guardrail prompts, TTS cleaner across 12 test files). No LLM-judged eval
  harness or graded call-quality benchmark exists.
- **Content-Security-Policy:** baseline headers ship (HSTS, nosniff, framing,
  referrer, permissions-policy); CSP deliberately not added (dashboard ships
  framework-inline scripts). Needs a deliberate follow-up, not a blind header.
- **Restore drill:** `scripts/restore.sh` exists but a backup→restore round
  trip has not been executed and timed in this environment.

## Blocked (operator-side)

- **Real-phone chain (the Definition of Done):** no PSTN call has ever run
  through this system. Needs a telephony gateway, `VOICE_PROVIDER=generic`
  credentials, STT/TTS provider keys, and a called number. Nothing can
  substitute for this step.
- **Production traffic behavior:** rate-limit tuning, pool sizing, and
  p95 latency under real load are unmeasured.

## Remaining Risks

- Single global secrets per channel (voice HMAC, media token, n8n tokens):
  the gateway is a fully trusted party; per-tenant credentials don't exist.
- Single-region Postgres/Redis with no HA/failover story beyond backups.
- No WAF/bot mitigation beyond app-level rate limiting.
- VIEWER (read-only) role deferred by operator decision — API currently has
  three roles; dashboard role-awareness is minimal (users/agent pages).
- Back-to-back local suite runs share Redis buckets (dev-only quirk; CI
  provisions fresh Redis per run).

## Tests

34 files / 288 tests, all executed against real Postgres+pgvector+Redis
(single-fork, zero skips; checker `OK — full suite executed, nothing
skipped`). Coverage per phase: webhook concurrency/idempotency (B–E),
redaction/storage/rate-limit/pricing/headers (F), notification/handoff/n8n
lifecycle incl. race proofs (G), tenancy/RBAC matrix incl. HTTP-layer 403/404s
(H), maintenance/cron/race-409s/lockout honesty (I), plus call-lifecycle and
Redis E2E. Repeated-run stressing caught and fixed one real test-ordering bug
and one vacuous lockout test. Lint + typecheck + build clean.

## Real Voice Verification — NOT PERFORMED

Operator checklist (do this before any staging claim):

1. Set `VOICE_PROVIDER=generic` + `VOICE_API_BASE_URL`/`VOICE_API_KEY`,
   `VOICE_WEBHOOK_SECRET`, `STT_PROVIDER`/`TTS_PROVIDER` + keys,
   `VOICE_MEDIA_TOKEN`, `VOICE_MEDIA_PUBLIC_URL=wss://<host>/media`;
   point the gateway callbacks at
   `https://<domain>/api/v1/webhooks/voice/*`; run `npm run maintenance`
   on cron (*/10).
2. Place a real inbound call. Expected evidence in order: `call-started`
   200 + `calls` row (RINGING→IN_PROGRESS); media `start` accepted;
   Persian STT transcript rows; agent reply + tool audit rows (lead
   created in the right business); TTS audio archived; `call-ended` 200
   + summary + `call-completed` notification; transfer (if requested)
   → TRANSFERRING→TRANSFERRED or honest TRANSFER_FAILED + callback.
3. Redeliver one webhook (same idempotency key) → expect duplicate-safe
   no-op; replay with a bad signature → expect 401; call from an
   unknown number → expect clean lead creation, no cross-tenant rows.
4. Record: audio quality notes, STT accuracy sample, p95 turn latency,
   and any `FAILED` notification/usage rows with reasons.

## Production Readiness: READY FOR INTERNAL TESTING

Rationale: the codebase is hardened (failure modes are explicit and
fail-closed everywhere we could reach), the suite is green against real
infrastructure, and operations (migrate, backup, cron, rate limits, prod
fail-fast) are wired. But zero real-call minutes exist, so STAGING is gated
on checklist §Real Voice Verification, and LIMITED PRODUCTION additionally
on a soak period, a restore drill, and the CSP decision.
