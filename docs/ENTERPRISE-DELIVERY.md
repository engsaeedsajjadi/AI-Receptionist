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

- GitHub Actions run 37171619155 on commit 25a9359: 325 tests passed across 43 files, zero skipped, including PostgreSQL, Redis, tenant isolation, concurrent refresh, CRM, MFA and agent memory. Both migration runs and production build passed.
- Coverage on that run: lines/statements 63.02%, branches 70.06%, functions 70.32%. The 80% gate correctly failed; it has not been lowered or narrowed.
- Dependency scanning found vulnerable baseline versions. Next.js was upgraded within version 16 to 16.3.8; Nodemailer to 10.0.14 and PostCSS to 8.5.23. A subsequent local production dependency audit reports zero known vulnerabilities. Current CI must revalidate the upgraded dependency set.
- New passwords use full-input scrypt; legacy bcrypt remains readable. Long Persian passwords and malformed hash parameter rejection have dedicated tests.
- Prometheus endpoint, Grafana provisioning, OTLP trace export and optional rolling/customer memory are implemented. Dashboard configuration exposes model/temperature/tool/retrieval/memory settings. Live deployed telemetry/provider acceptance is still pending.
- Further dashboard API contracts and input-size limits are being validated in the next CI run. See ENTERPRISE-TEST-REPORT.md for the final recorded run.

## Outstanding release requirements

Subscriptions/invoices/atomic quota reservation; full agent intent classification and evaluated verification; document ACL/versioning/metadata/reranking/analytics; native telephony connectors and real streaming/cloning acceptance; configurable follow-up rules; notification scheduling/templates/WhatsApp; platform tenant administration; complete UX and browser E2E; measured 80% coverage; deployed telemetry, deployment/restore drills and live provider acceptance.

No placeholder payment success, synthetic provider success or fabricated analytics is substituted for these capabilities. This is not completion of all twenty requirements. Do not merge/deploy solely because compilation and functional tests succeed.
