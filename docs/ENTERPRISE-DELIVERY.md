# Enterprise implementation checkpoint — 2026-10-04

This branch is an implementation in progress, **not an approved production release**. The original architecture audit was committed before code changes. Existing Next.js/Drizzle/provider boundaries are retained.

## Implemented changes

- Atomic refresh rotation with SHA-256 token hashes, replay revocation and immediate access-session revocation; inactive tenant checks; credential versions; device session list/revoke; logout-all.
- Tenant request context, trace/request correlation, capability roles, tenant feature flags, scoped cache and composite tenant foreign keys. `business_id` remains the tenant identifier. No parallel tenant hierarchy is introduced.
- Password reset and email verification through configured SMTP, encrypted RFC6238 MFA with single-use recovery codes, explicit Google/Microsoft OIDC linking with PKCE/state/nonce and subsequent MFA where enabled. OAuth endpoints require registered provider credentials; live acceptance remains unverified.
- Validated knowledge tool evidence enters the system prompt as quoted untrusted data. Indexed documents only. Tool allowlists and model selection are enforced. Agent configuration changes retain historical snapshots.
- CRM pipelines/opportunities/tasks, stage transitions and tenant-scoped relationships with Persian dashboard.
- Durable automation worker with leases, retry/backoff, exhausted-job state, manual retry and dashboard. Call completion and its automation job commit atomically. Other event sources still require conversion to a transactional outbox.
- Signed timestamp enforcement for production voice webhooks, webhook key overlap, bounded streaming body reads and corrected audio frame rejection.
- Pinned migration-lock connection, additional migrations, CI with PostgreSQL/Redis, no-skipped-tests checks and an 80% coverage gate. Gate configuration does not establish that coverage has been reached.

## Evidence

- Latest local lint and TypeScript checks passed.
- Latest local unit run: 186 passed, 21 files, zero failed (2026-10-04).
- Next.js production compilation succeeded during the previous implementation session; revalidation after subsequent changes is required.
- Previous PostgreSQL-compatible embedded run: 310 passed and one webhook tool-call test did not complete successfully. Embedded multiplexing cannot qualify production concurrent connections.
- Migrations through 0011 were started in the previous session, but its final test output was lost when the transient runtime restarted. Do not treat that run as a pass.
- Redis integration, external OAuth/SMTP/voice/payment, Docker deployment, browser accessibility and backup restore acceptance are not established by the unit run.

## Outstanding release requirements

Subscriptions/invoices/atomic quota reservation; complete agent intent/memory pipeline; document ACL/versioning/metadata/reranking/analytics; native telephony connectors and real streaming/cloning acceptance; configurable follow-up rules; notification scheduling/templates/WhatsApp; platform tenant administration; OpenTelemetry/Prometheus/Grafana; complete UX and browser E2E; measured 80% coverage; deployment/restore drills.

No placeholder payment success, synthetic provider success or fabricated analytics is substituted for these capabilities. Do not merge/deploy solely because compilation succeeds.
