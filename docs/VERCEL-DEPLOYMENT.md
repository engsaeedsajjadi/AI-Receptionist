# SajjadiDev Reception: Vercel demo deployment

Baseline: `enterprise/hardening-2026-10-03` at `13d4ae235a4b45fd962e34e523ac035d0fa2a8d0`.
Preparation branch: `deployment/vercel-demo`.

This is deployment preparation, not evidence of an online or production-ready system.
No provider accounts, billing plans, API credentials or live infrastructure are provisioned by these files.

## Architecture and demo scope

- Vercel: existing Next.js UI and HTTP API, including the existing recorded-audio voice test.
- Managed PostgreSQL: must support `vector` and `pg_trgm`; use a connection pooler for application traffic and a direct/session connection for migrations.
- Redis: remote TLS Redis protocol endpoint (`rediss://`), compatible with the existing `ioredis` commands including Lua. An HTTPS REST URL is not interchangeable.
- Object storage: private S3-compatible bucket. Local storage and `/tmp` are not durable file storage.
- AI: use real provider credentials. The default template uses OpenAI for simplicity; it is not a promise of free API use. Existing compatible/Gemini settings may be substituted after validating model availability and embeddings compatibility (1536 dimensions).
- Telephony: disabled for the first web demo. The persistent `scripts/media-server.ts` is not migrated to Vercel by this change. Browser voice tests are request/response audio, not a PSTN call.
- Worker: `/api/internal/worker` attempts at most one leased outbox event and one automation job per request. It is an operator-only endpoint, authenticated with a dedicated `CRON_SECRET` of at least 32 characters. Configure a trusted scheduler or run the existing `npm run worker` on an operator machine during supervised demos. A successful HTTP response means work was attempted, not that an external notification was delivered.
- Maintenance: continue scheduling `npm run maintenance` separately; the worker tick does not run retention, reconciliation or all maintenance tasks.

No cron schedule is installed automatically. Confirm account plan and scheduling limits first. With no worker/scheduler, deferred notifications/webhooks remain queued. Do not advertise them as delivered. For higher volume or slow handlers use the existing persistent worker. Serverless termination may leave a lease for later recovery; provider timeout and lease-duration alignment must be validated with real integrations.

## Files added / changes

- `vercel.json`: Next.js build, preflight gate and 300-second API duration (requires supported plan/runtime settings).
- `docs/vercel.env.example`: configuration template with blank secrets.
- `npm run vercel:preflight`: shape validation only, without network or secret output.
- Production on Vercel rejects local object storage, local Docker hosts, non-TLS Redis, oversized upload settings and oversized connection pools.
- PostgreSQL defaults to two connections per instance on Vercel. This does not cap the total across instances; use the provider pooler and concurrency/usage controls.
- Next.js explicitly bundles the migration journal used by readiness.
- Auth, tenant isolation, production provider guards and Docker paths remain in place.

## Setup order

1. Connect the GitHub repository to Vercel, choose **Next.js**, repository root, Node.js **22.x**, and branch `deployment/vercel-demo`. Keep preview data isolated from any production database. Confirm whether your use is permitted by the selected plan; Hobby is restricted to personal non-commercial use. No upgrade or paid purchase is authorised by this guide.
2. Provision/select a disposable demo PostgreSQL database, TLS Redis and private S3-compatible bucket. Select nearby regions. Check current quotas and terms on each provider; no zero-cost guarantee is made.
3. Enter `docs/vercel.env.example` values in the Vercel environment UI. Never commit populated env files or paste secrets into chat. Use separate random JWT/webhook/scheduler secrets; `IDENTITY_ENCRYPTION_KEY` must be 64 hexadecimal characters. APP_URL must be the actual stable HTTPS deployment origin. Vercel sets `VERCEL=1` itself; do not invent a deployment URL.
4. Run migrations **once from a trusted operator machine**, against the direct/session database URL: `npm run db:migrate`. The runner uses session advisory locks; a transaction pooler is inappropriate. Use a fresh demo DB, back up existing databases before changing their schema. Do not run migrations or demo seeding as part of every Vercel build.
5. Run `npm run vercel:preflight` locally with equivalent private settings. On PowerShell you can copy the template to a separate ignored env file in an isolated checkout, populate it locally and set `DOTENV_CONFIG_PATH` to that path. This validates shape, not connectivity. The Vercel build runs it automatically.
6. Deploy, then check `/api/health/live` and `/api/health/ready`. Ready validates database/Redis and configuration, not live S3 permissions or AI quality. Test an actual upload/download and an actual AI interaction.
7. Use the existing registration flow to create the demo tenant with a strong unique password. Do not publish a platform SUPER_ADMIN account or use default seed credentials. Protect evaluator access and set provider-side spending limits before public exposure. Registration is currently public and rate-limited; it is not invite-only.
8. Configure `CRON_SECRET` and an authenticated scheduler to call `POST /api/internal/worker` with `Authorization: Bearer <secret>`. The GET variant exists for Vercel Cron compatibility. Never place the secret in a URL. Monitor queue status; tune cadence against measured load and plan limits. Configure maintenance separately.
9. Perform the acceptance checklist below before adding the URL to the investment application.

## Existing upload / AI constraints

Vercel request/response payload limits apply before application code. This template limits document uploads to 4 MiB to leave multipart headroom under the documented 4.5 MB platform limit. Larger files need a separate direct-upload ingestion design. Large generated/exported payloads and long base64 audio responses can also exceed response limits; keep demo audio short and verify actual payload sizes.

Document ingestion uses strict malware scanning in production. Configure the existing `MALWARE_SCAN_URL` contract; without it, uploads fail closed. Do not turn strict scanning off to make a deployment appear healthy. Text/knowledge flows and uploaded-document flows must each be tested.

Function duration is not a guarantee that a multi-step AI turn will finish. Model retries and tool iterations consume the same time budget. Browser voice testing must be measured with real credentials; PSTN streaming requires separate work.

## Acceptance checklist

- [ ] Preflight and build pass on the connected Vercel account.
- [ ] Migrations applied; readiness reports healthy from the deployed host.
- [ ] Login, refresh and logout work over HTTPS; no token/secret appears in logs.
- [ ] Agent configuration saves and reloads.
- [ ] Lead create/update and appointment overlap protection behave correctly.
- [ ] Tenant A cannot access tenant B's data.
- [ ] Knowledge upload passes scanner, indexes, retrieves and downloads correctly from private storage.
- [ ] Real model answers a known question; unknown information triggers clarification.
- [ ] Browser audio input/output succeeds with short clips (only if enabled/configured).
- [ ] Worker rejects absent/wrong credentials and drains a test event with valid operator credentials.
- [ ] No delivery is shown as successful merely because an event is queued.
- [ ] Backup, maintenance schedule, usage limits and recovery steps recorded.
- [ ] Public/evaluator access and plan terms reviewed before sharing the demo URL.

## Cost boundary and sources

Free-tier eligibility and usage allowances are separate from software compatibility. Do not purchase a plan or assume commercial Hobby eligibility just because the venture has no customers. AI, speech and telephone usage are independently metered.

Official documentation reviewed 11 October 2026:
- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/websockets (beta; connections end with function duration)
- https://vercel.com/docs/cron-jobs/manage-cron-jobs

## راهنمای کوتاه فارسی

کد برای استقرار وب روی Vercel آماده‌سازی شده است؛ هنوز دموی آنلاین ساخته نشده. ابتدا اتصال Vercel، دیتابیس PostgreSQL دارای pgvector، Redis با TLS، فضای فایل S3 و کلیدهای واقعی AI لازم است. اطلاعات محرمانه فقط داخل تنظیمات سرویس قرار می‌گیرند. برای نسخه اول، تماس تلفنی غیرفعال است اما مسیر تست صوت مرورگری موجود حفظ شده. صف پس‌زمینه بدون زمان‌بندی اجرا نمی‌شود؛ endpoint جدید فقط اجرای محدود و احرازهویت‌شده را فراهم می‌کند. هیچ داده نمایشی به‌عنوان مشتری واقعی معرفی نمی‌شود.

## Preparation validation (11 October 2026)

- `npm ci`: completed from committed lockfile.
- `npm run typecheck`: passed.
- `vitest` targeted env/deployment suites: 17 tests passed across 2 files.
- `npm run build`: passed, including the bounded worker route.
- Build trace includes `drizzle/meta/_journal.json` in readiness function bundle.
- Preflight with synthetic configuration-only values: passed without network calls. This is not live-provider evidence.
- `git diff --check`: passed.
- Vercel cloud build, live database migrations, real provider calls and browser E2E: not run in this preparation session.
