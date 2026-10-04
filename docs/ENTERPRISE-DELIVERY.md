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

- GitHub Actions run 37186769147 on commit 42e285a: 350 tests passed across 49 files, zero skipped, including PostgreSQL, Redis, tenant isolation, concurrent refresh, CRM, MFA and agent memory. Both migration runs and production build passed.
- Coverage on that run: lines/statements 71.88%, branches 72.03%, functions 76.45%. The 80% gate correctly failed; it has not been lowered or narrowed.
- Dependency scanning found vulnerable baseline versions. Next.js was upgraded within version 16 to 16.3.8; Nodemailer to 10.0.14 and PostCSS to 8.5.23. A subsequent local production dependency audit reports zero known vulnerabilities. The same remote CI run also passed the production dependency audit.
- New passwords use full-input scrypt; legacy bcrypt remains readable. Long Persian passwords and malformed hash parameter rejection have dedicated tests.
- Prometheus endpoint, Grafana provisioning, OTLP trace export and optional rolling/customer memory are implemented. Dashboard configuration exposes model/temperature/tool/retrieval/memory settings. Live deployed telemetry/provider acceptance is still pending.
- Dashboard API contracts, input-size limits, platform administration and manual invoice billing passed in the recorded CI run. See ENTERPRISE-TEST-REPORT.md for the final recorded run.

## Outstanding release requirements

Automatic payment gateway, recurring collection and atomic quota reservation; full agent intent classification and evaluated verification; document ACL/versioning/metadata/reranking/analytics; native telephony connectors and real streaming/cloning acceptance; configurable follow-up rules; notification scheduling/templates/WhatsApp; platform provisioning and expanded administration; complete UX and browser E2E; measured 80% coverage; deployed telemetry, deployment/restore drills and live provider acceptance.

No placeholder payment success, synthetic provider success or fabricated analytics is substituted for these capabilities. This is not completion of all twenty requirements. Do not merge/deploy solely because compilation and functional tests succeed.

Platform tenant listing and suspension/reactivation with MFA-gated SUPER_ADMIN access, atomic session revocation and audit records are implemented and passed remote integration tests in run 37186438061. See deployment documentation for audited bootstrap. Atomic usage quotas and automatic payment collection remain outstanding.

Manual invoice billing now provides configured plan pricing, immutable invoice snapshots, tenant invoice management, MFA-protected operator settlement with globally unique payment references, atomic monthly subscription activation/renewal and cancellation. Billing limits are not yet enforced. This is a manual-invoice workflow, not a payment processor integration. See ENTERPRISE-BILLING.md.

## Twenty-area delivery matrix

“Partial” means working changes exist but the entire requested area has not met acceptance. No row below constitutes production certification.

| Requested area | Working implementation / current evidence | Remaining scope |
| --- | --- | --- |
| 1. Tenancy | Tenant context, guards on changed services, composite FKs, cache/flags and platform state management | Exhaustive table/service review, expanded control plane and RLS decision |
| 2. Identity | Rotation/sessions, reset/verification, MFA, roles and OIDC linking | Live OAuth/SMTP acceptance, cross-tab refresh coordination |
| 3. Agent engine | Tools/model/personality configuration, versions and optional memory | Full intent pipeline and evaluated verification |
| 4. RAG | Existing hybrid search hardened; knowledge evidence injected into final-answer context | Document ACLs, versions, metadata filters, reranking and analytics |
| 5. Voice | Existing voice path retained; request/frame security fixes | Streaming provider acceptance, full interruption/noise/cloning support |
| 6. Telephony | Existing provider/gateway boundaries retained | Native Twilio/SIP/Asterisk/FreeSWITCH integrations and live calls |
| 7. CRM | Customers/leads plus pipelines, opportunities, tasks and Persian dashboard | Complete scoring/funnel/follow-up configuration |
| 8. Automation | Durable leased jobs, retry/dead-letter handling and worker | Full transactional outbox and configurable business workflow rules |
| 9. Notifications | Existing delivery/status channels retained | Templates, scheduling, WhatsApp and full retry acceptance |
| 10. Billing | Manual invoice lifecycle and audited subscription reconciliation | Atomic quotas, automatic collection, tax/refund ledger and full meter acceptance |
| 11. Admin | Existing dashboard plus security/CRM/automation/tenant/billing screens | Complete cross-tenant analytics and remaining charts |
| 12. Observability | Request/trace context, protected Prometheus endpoint, OTLP and Grafana config | Deployed acceptance, alerts and performance baselines |
| 13. Security | Identity/tenant/webhook/body/dependency hardening with regression tests | Complete security review, penetration testing and unresolved report items |
| 14. Storage | Existing storage/provider code preserved | Complete tenant path/permissions/retention and production backend acceptance |
| 15. Testing | Real PostgreSQL/Redis CI, regression and server-side E2E tests | 80% coverage, browser E2E and live provider/load acceptance |
| 16. DevOps | Migrations, environment examples, CI gates and production Compose updates | Deployment job, image hardening/scanning, backup/restore/rollback drills |
| 17. UX | Persian dashboard modules wired to real APIs | Complete responsive/dark-mode/accessibility/browser validation |
| 18. AI features | Existing summaries plus optional conversation/customer memory | Evaluated sentiment, scoring, extraction, recommendations and quality monitoring |
| 19. Code quality | Typed services, focused refactoring and API/database/security documentation | Repository-wide quality gates and remaining duplicated paths |
| 20. Delivery | Reviewable GitHub branch/draft PR, migrations/configuration/docs and test evidence | Production-ready release, all acceptance criteria and deployment evidence |
