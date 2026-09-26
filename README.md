# AI Receptionist — Persian AI Telephone Receptionist MVP

Production-oriented multi-tenant AI telephone receptionist for Persian-speaking businesses.
Inbound calls are answered by an LLM agent that speaks Persian, searches the business knowledge
base (RAG), lists/searches real-estate properties, captures leads, books appointments, and
hands off to a human when needed — with full tenant isolation, audit trails, and cost tracking.

Stack: **Next.js 15 (TypeScript, API Routes) · PostgreSQL 16 + pgvector · Drizzle ORM ·
Redis · n8n · Docker**. Persan-first RTL dashboard (English + Persian UI).

## Features

- **AI call agent** — tool-calling LLM loop (OpenAI-compatible; Anthropic-ready) with
  guardrailed system prompt, max 6 tool iterations, honest-failure policy, and Persian
  guardrails (`src/lib/guardrails.ts`, `src/lib/services/agent.ts`).
- **Persian language services** — digit normalization, Persian number words → integers,
  rial→toman money, area/bedroom/phone parsing (`src/lib/normalization.ts`).
- **Real RAG pipeline** — file upload (PDF/DOCX/TXT/MD, magic-byte sniffed) → text
  extraction → chunking → OpenAI embeddings → pgvector hybrid search: vector cosine
  ranking + keyword term match-count ranking fused by reciprocal-rank fusion (RRF,
  k=60), with degraded keyword-only fallback when embeddings are unavailable
  (`src/lib/services/knowledge.ts`).
- **Property search** — filters (type, deal, price, area, bedrooms, location), Persian
  query parsing, per-tenant + active-only scoping.
- **Lead engine** — `upsertLeadFromCall` with in-tenant phone dedup (30-day window),
  reopen-closed, and existing-customer flagging.
- **Appointment engine** — working-hours config, holidays, buffer time, transactional
  overlap prevention, reschedule/cancel, reminders.
- **Call lifecycle** — provider webhooks (HMAC-signed, timestamp replay window, Redis
  idempotency dedupe), call records, transcripts, human handoff (`transfer_call`).
- **Auth & RBAC** — JWT access + rotating refresh tokens (reuse detection), bcrypt,
  account lockout, `ADMIN/MANAGER/AGENT` roles with per-resource enforcement,
  hard tenant scoping on every query.
- **Notifications & usage** — SMS/email/console adapters, per-business usage events with
  token→USD cost tracking, daily rollups.
- **n8n integration** — production webhook flows for post-call processing, lead-created,
  and appointment reminders (`n8n/`).
- **Dashboard** — RTL Persian dashboard with real API data: overview, calls, leads,
  appointments, properties, customers, knowledge, agents, inbox, reports, settings.
- **Ops** — `/api/health` + `/api/ready`, structured JSON errors, request-id logging,
  Redis rate limiting, S3-compatible storage w/ signed URLs, backup/restore scripts.

## Quick start (Docker Compose)

Prerequisites: Docker + Docker Compose.

```bash
cp .env.example .env        # fill secrets (see Configuration)
docker compose up --build   # app :3000, postgres :5432, redis :6379, n8n :5678
```

Migrations run automatically on app start (`docker-entrypoint.sh`).

## Local development

```bash
npm install
cp .env.example .env
# start postgres (pgvector) + redis, e.g.: docker compose up -d postgres redis
npm run db:migrate
npm run dev                 # http://localhost:3000
```

Seed demo data (2 isolated demo businesses): `npm run db:seed`.

## Configuration

Environment is validated at boot and the app **fails fast** on invalid config
(`src/lib/env.ts`).

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres 16 connection string (pgvector + pg_trgm enabled by migrate) |
| `REDIS_URL` | yes (prod) | Redis URL; unset ⇒ in-memory fallbacks, dev/test only |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | yes (prod) | ≥32 chars in production (fail-fast) |
| `VOICE_WEBHOOK_SECRET` / `N8N_WEBHOOK_SECRET` | yes (prod) | HMAC secret for voice webhooks / bearer token n8n validates via Header Auth |
| `LLM_PROVIDER` | no | `openai` / `compatible` / `dev` (default `dev`; `dev` rejected in prod) |
| `OPENAI_API_KEY` | for openai | Required when any `*_PROVIDER=openai` (LLM, STT, TTS, embeddings) |
| `COMPATIBLE_LLM_*` | for compatible | Base URL (+key/model) for OpenAI-compatible gateways |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | no | `openai` / `dev`; dims must match the pgvector column (1536) |
| `VOICE_PROVIDER` + `VOICE_API_BASE_URL`/`VOICE_API_KEY` | for calls | `generic` / `dev`; generic requires base URL + key in prod |
| `VOICE_MEDIA_PUBLIC_URL` / `VOICE_MEDIA_TOKEN` | for streaming | `wss://<host>/media` + gateway↔sidecar token; empty ⇒ no gateway audio |
| `STT_PROVIDER` / `TTS_PROVIDER` (+ models) | no | `openai` / `compatible` / `dev` (default `dev`) |
| `STORAGE_PROVIDER` | no | `local` (default, `./storage`) / `s3` (needs `S3_ENDPOINT` + keys in prod) |
| `NOTIFICATION_DEFAULT_CHANNEL` | no | `internal` (default, dashboard inbox) / `email` (needs `SMTP_*`) |
| `N8N_ENABLED` / `N8N_URL` | no | Automation events; off by default |
| `N8N_API_KEY` | for n8n | Bearer key n8n presents to `POST /api/v1/automation/dispatch` (required in prod when `N8N_ENABLED=true`) |
| `N8N_MAX_RETRIES` | no | Emit retries on network/429/5xx (default 2); all attempts share one idempotency key |
| `TRUST_PROXY` | via proxy | `true` when behind nginx (prod compose sets it); else `X-Forwarded-For` ignored |

See `.env.example` for the full list with defaults.

## Voice integration (real calls)

The voice path is provider-agnostic: telephony gateways talk to the app over
HMAC-signed webhooks, and exchange live audio with the media sidecar over WebSocket.

- Webhooks — `POST /api/v1/webhooks/voice/call-started|audio|transcript|tool-call|call-ended`
  (`VOICE_PROVIDER=generic`, `VOICE_WEBHOOK_SECRET`). Byte-exact HMAC-SHA256 signatures,
  ±5 min timestamp window, DB-backed idempotency keys (safe redelivery + concurrency).
- Call turns — `src/lib/voice/turn.ts`: audio → STT → guardrailed agent turn (audited
  tools only) → speakable-text cleaning → TTS → archived audio for gateway playback.
  Gateway-side STT is supported via the transcript topology.
- Media sidecar — `scripts/media-server.ts` (prod compose `media` service, nginx
  `/media` → `media:3001`, `VOICE_MEDIA_PUBLIC_URL=wss://<host>/media`): bidirectional
  audio frames + barge-in, authenticated per-call with `VOICE_MEDIA_TOKEN`.
- Speech — `STT_PROVIDER`/`TTS_PROVIDER` (`openai`/`compatible`; Persian-first prompts).

Required for production: `VOICE_PROVIDER=generic` + `VOICE_API_BASE_URL`/`VOICE_API_KEY`,
`VOICE_WEBHOOK_SECRET`, STT/TTS provider keys, `VOICE_MEDIA_TOKEN`, and provider-side
configuration pointing callbacks at `https://<your-domain>/api/v1/webhooks/voice/*`.
With `dev` providers (or missing keys) every hop fails honestly with
`PROVIDER_NOT_CONFIGURED` — the pipeline never fakes audio, transcripts, or success.

## n8n workflows

Import the JSON files from `n8n/` manually (there is no automatic sync).
Each workflow is `Webhook (Header Auth) → Prepare Dispatch → Dispatch via App
→ Respond`: n8n validates the `x-automation-token`, builds the message, and
POSTs it back to `POST /api/v1/automation/dispatch`, where the app dedups on
`(businessId, idempotencyKey)` in Postgres and performs the provider send.
Critical dedup state lives only in the app database — never in n8n static data.

- `new-lead.json` — new-lead alerts to the sales Telegram chat
- `call-completed.json` — call summary to the ops chat
- `appointment.json` — created/rescheduled/cancelled notices to the ops chat
- `human-handoff.json` — transfer/failure escalation (failures → urgent chat)
- `notification.json` — generic fan-out template (no app emitter yet)

Setup details (credentials, env vars, delivery semantics): `n8n/README.md`.

## Backups

```bash
DATABASE_URL=... ./scripts/backup.sh [dir] [retention-days]  # timestamped pg_dump, prunes >14d
DATABASE_URL=... ./scripts/restore.sh <dump-file>            # guarded against prod targets
```

Schedule `backup.sh` via cron/systemd for production. Migration rollback: forward-only
migrations — restore from a pre-deploy dump, then `npm run db:migrate`.

## Testing

```bash
npm test          # vitest: unit + DB-gated integration + AI eval
npm run lint && npm run typecheck
```

- `tests/unit` — normalization, guardrails, RBAC, tool schemas, cost, env, security.
- `tests/integration` — tenant isolation, leads, appointments, auth, webhooks,
  notifications/usage, knowledge. Need `TEST_DATABASE_URL` (or `DATABASE_URL`); they
  skip automatically when no database is reachable.
- `tests/ai/eval.test.ts` — deterministic eval cases (Persian understanding, tool
  contract, guardrail fallbacks) + live-LLM smoke cases gated on
  `TEST_DATABASE_URL` + a live `LLM_PROVIDER` (they skip otherwise, never fail).
- `tests/e2e` — critical journeys: full call lifecycle (started → turns → ended →
  billed + notified) and Redis-backed behavior (locks, rate limits, turn markers)
  against a real server (`REDIS_URL` / `TEST_REDIS_URL`).

CI (`.github/workflows/ci.yml`): lint → typecheck → **migrate-from-zero validation** →
full suite on real postgres (pgvector) + redis → **execution gate**
(`scripts/ci/check-test-results.mjs` fails the build if ANY test skips, so green
means every integration/E2E file ran) → production build → docker build →
**prod boot smoke** (compose stack up with dummy secrets, `/ready` + nginx `/media`
WebSocket assertions, always torn down).

## API surface

Base path `/api/v1` (auth: Bearer JWT unless noted; errors:
`{ success: false, error: { code, message, requestId } }`):

- `POST /auth/{register,login,refresh,logout,logout-all}`, `GET /auth/me`
- `GET /calls`, `GET /calls/:id`, `GET /calls/:id/{summary,transcript}`, `GET/POST /calls/:id/transfer`
- `GET/POST /leads`, `GET/PUT/DELETE /leads/:id`, `GET/POST /leads/:id/notes`, `POST /leads/:id/assign`
- `GET/POST /appointments`, `GET/PUT/DELETE /appointments/:id` (PUT = reschedule, DELETE = cancel)
- `GET/POST /properties`, `GET/PUT/DELETE /properties/:id`, `POST /tools/properties/search`
- `GET/POST /customers`, `GET/PUT /customers/:id`, `GET /customers/:id/history`
- `GET/POST /knowledge`, `GET/PUT/DELETE /knowledge/:id`, `POST /knowledge/{search,upload,reindex}`
- `GET/POST /agents`, `GET/PUT/DELETE /agents/:id`, `POST /agents/:id/{activate,deactivate}`
- `GET/PUT /business`, `GET/PUT /business/settings`, `GET/POST /users`, `GET/PUT/DELETE /users/:id`
- `POST /agent/chat`, `GET /notifications`, `GET /usage`, `GET /files/[...key]` (signed URL)
- `POST /webhooks/voice/{call-started,audio,transcript,tool-call,call-ended}` (HMAC)
- `POST /automation/dispatch` (`N8N_API_KEY` Bearer; n8n fan-out)
- `GET /api/health`, `GET /api/health/{live,ready}` (no `/v1` prefix; live is the only unthrottled probe)

Role gates (`ADMIN` > `MANAGER` > `AGENT`; every tenant read/write is additionally
business-scoped, and role/business come from the DB user, not the JWT):

| Operation | Minimum role |
|---|---|
| Business update/settings, agents write (create/update/delete/activate), user update/delete | `ADMIN` |
| User list/read, create `AGENT`, knowledge write, properties write, lead assign/delete | `MANAGER` |
| Lead assignment via create/update payloads | `MANAGER` (AGENT gets 403, same as `/assign`) |
| Everything else (calls, leads, appointments, customers, chat, lists) | any authenticated role |

Safety rails: the last active `ADMIN` cannot be demoted/deactivated/deleted;
assignee and appointment references must exist in the same business (else 404).

## Security notes

- Tenant isolation enforced in every service/route; integration-tested cross-tenant denial.
- LLM never touches the DB directly and never receives secrets (only tool results).
- No secrets in logs: `src/lib/logger.ts` redacts secret keys (case-insensitive) +
  bearer strings before pino, with pino `redact` paths as a second layer
  (`tests/unit/redaction.test.ts` pins this, including real log output).
- Webhook HMAC + replay window; every API route is authenticated (JWT context),
  HMAC/signature verified (webhooks, signed file URLs, refresh-token possession),
  or a rate-limited credential entry point (`auth/login`, `auth/register`).
  Only `/api/health/*` are unauthenticated info endpoints, and every route except
  `/api/health/live` is Redis-backed rate limited (60/min default; tighter presets
  on login/AI/upload).
- Signed capability URLs for local file downloads (`/api/v1/files/[...key]`);
  storage keys are traversal-proof and tenant-scoped (`tests/unit/storage.test.ts`).
- Baseline response headers (HSTS, nosniff, DENY framing, no-referrer,
  restrictive permissions-policy) in `next.config.ts`. No CSP yet: the dashboard
  ships framework-inline scripts — add one deliberately, not blindly.
- Production requires strong JWT secrets, `TRUST_PROXY=true` behind nginx, TLS
  (see `nginx/` + prod compose). Costs are recorded as estimates from a verified
  pricing table (`src/lib/pricing.ts`, overridable via `PRICING_JSON`).

## Deployment

Production compose (`docker-compose.prod.yml`): app + postgres + redis + n8n + nginx TLS
reverse proxy (`nginx/nginx.conf`). Set all required env, provision certificates, run
migrations, then `docker compose -f docker-compose.prod.yml up -d`.
