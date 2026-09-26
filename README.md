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
  rial→toman money, area/bedroom/phone parsing (`src/lib/persian/`).
- **Real RAG pipeline** — file upload (PDF/DOCX/TXT/CSV/MD, magic-byte sniffed) → text
  extraction → chunking → OpenAI embeddings → pgvector hybrid search (vector + keyword,
  RRF fusion) with degraded keyword-only fallback (`src/lib/services/knowledge.ts`).
- **Property search** — filters (type, deal, price, area, bedrooms, location), Persian
  query parsing, per-tenant + active-only scoping.
- **Lead engine** — `upsertLeadFromCall` with in-tenant phone dedup (30-day window),
  reopen-closed, and existing-customer flagging.
- **Appointment engine** — working-hours config, holidays, buffer time, transactional
  overlap prevention, reschedule/cancel, reminders.
- **Call lifecycle** — provider webhooks (HMAC-signed, timestamp replay window, Redis
  idempotency dedupe), call records, transcripts, human handoff (`transfer_call`).
- **Auth & RBAC** — JWT access + rotating refresh tokens (reuse detection), bcrypt,
  account lockout, `ADMIN/MANAGER/AGENT/VIEWER` roles with per-resource enforcement,
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
| `DATABASE_URL` | yes | Postgres connection string (pgvector enabled) |
| `REDIS_URL` | no | Redis URL; memory fallbacks apply when unset (dev only) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | yes (prod) | ≥32 chars in production |
| `OPENAI_API_KEY` | for AI/RAG | LLM + embeddings |
| `LLM_PROVIDER` / `LLM_MODEL` | no | `openai` (default), `openai-compatible`, `anthropic`; default `gpt-4o-mini` |
| `LLM_BASE_URL` | for compatible | e.g. local gateway for `openai-compatible` |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | no | `openai` / `dev`; `text-embedding-3-small` |
| `VOICE_PROVIDER` / `VOICE_*` | for calls | `mock` (dev), `twilio`, `arvan`-style `webhook`; see Voice below |
| `STT_PROVIDER` / `TTS_PROVIDER` | no | `openai` (whisper/gpt-4o-mini-tts), `mock` |
| `VOICE_WEBHOOK_SECRET` | for calls | HMAC secret for provider webhooks |
| `S3_*` | no | Endpoint/bucket/keys; falls back to local `./storage` |
| `N8N_*` | no | n8n webhook integration |
| `SMS_*` / `EMAIL_*` | no | Notification providers |
| `NEXT_PUBLIC_APP_URL` | no | Public base URL |

See `.env.example` for the full list.

## Voice integration (real calls)

The voice layer is an abstraction (`src/lib/services/voice/`) with three adapters:

- `mock` — local dev/testing (no PSTN). Logs all operations; TTS returns text markers.
- `twilio` — real PSTN via Twilio Media Streams + TwiML (`VOICE_PROVIDER=twilio`).
- `webhook` — generic SIP-gateway adapter for Iranian providers (HMAC-signed callbacks).

Required for production: `VOICE_PROVIDER`, `VOICE_WEBHOOK_SECRET`, STT/TTS provider keys,
and provider-side configuration pointing webhooks at
`https://<your-domain>/api/v1/calls/webhook`. Webhook security: HMAC-SHA256 signature,
±5 min timestamp window, Redis idempotency keys. Without provider credentials the call
path is correctly abstracted but cannot place/answer real calls (reported, not faked).

## n8n workflows

Import from `n8n/` (or sync automatically when `N8N_API_URL`/`N8N_API_KEY` are set):

- `call-completed.json` — transcript → summary → knowledge/CRM sync
- `new-lead.json` — instant lead notification to the business
- `appointment.json` — scheduled reminder sender
- `human-handoff.json` — live handoff escalation
- `notification.json` — generic notification fan-out

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
  contract, guardrail fallbacks) + one live-LLM smoke case gated on
  `TEST_DATABASE_URL` + `OPENAI_API_KEY`.

CI (`.github/workflows/ci.yml`): lint → typecheck → **migrate-from-zero validation** →
full test suite (postgres + redis services) → production build → docker build.

## API surface

Base path `/api/v1` (auth: Bearer JWT; errors: `{ error: { code, message, requestId } }`):

- `POST /auth/{register,login,refresh,logout}`, `GET /auth/me`
- `GET/POST /calls`, `POST /calls/webhook` (HMAC), `POST /calls/:id/{transfer,hangup}`
- `GET/POST /leads`, `PATCH /leads/:id`, call-upsert + dedup
- `GET /availability`, `POST /appointments`, `POST /appointments/:id/{reschedule,cancel}`
- `GET/POST /properties`, `GET/POST /customers`, `POST /knowledge/upload`, `GET /knowledge/search`
- `GET /agents`, `GET /notifications`, `GET /usage`, `GET /reports/*`, `GET /dashboard/*`
- `GET /health`, `GET /ready`

## Security notes

- Tenant isolation enforced in every service/route; integration-tested cross-tenant denial.
- LLM never touches the DB directly and never receives secrets (only tool results).
- No secrets in logs; webhook HMAC + replay window; rate limits on auth/webhooks.
- Production requires strong JWT secrets, `TRUST_PROXY` review, TLS (see `nginx/` + prod compose).

## Deployment

Production compose (`docker-compose.prod.yml`): app + postgres + redis + n8n + nginx TLS
reverse proxy (`nginx/nginx.conf`). Set all required env, provision certificates, run
migrations, then `docker compose -f docker-compose.prod.yml up -d`.
