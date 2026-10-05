# Enterprise validation report — 2026-10-05

## Last completed remote run

GitHub Actions [37272324721](https://github.com/engsaeedsajjadi/AI-Receptionist/actions/runs/37272324721), commit `08c37c367b6a0e0f6ec2798ae65b1af287745a67`:

| Check | Observed result |
| --- | --- |
| Lint / TypeScript | Passed |
| PostgreSQL 16 + pgvector migrations, run twice | Passed |
| Redis 7 / PostgreSQL integration and server-side E2E | Included in 364 passing tests, 52 files |
| Failed / skipped tests | 0 / 0 |
| Coverage lines/statements | 72.43% |
| Coverage branches / functions | 73.38% / 77.94% |
| Required 80% coverage | **Failed** |
| Next production build | Passed |
| Production dependency audit | Passed, zero reported vulnerabilities |

Overall workflow failed because coverage is below the required threshold. Thresholds have not been lowered. Server-side E2E does not constitute browser, telephony, live OAuth, payment, or deployment acceptance. Test doubles validate provider contracts, not external provider availability.

## New control-plane and billing changes

New integration cases cover tenant-admin denial, MFA enforcement, safe pagination, suspension, credential invalidation, idempotent state transitions, audit records, self-tenant protection, missing tenants, invalid payloads and administrator demotion. These cases passed in the recorded run. The same run passed billing calendar/catalog tests and real PostgreSQL integration tests for tenant isolation, operator-only settlement, request idempotency, concurrent settlement, reference-reuse rollback, amount mismatch, renewal, cancellation and expiry. No external bank/gateway was contacted or claimed successful.

## Remaining acceptance

80% measured coverage; browser accessibility/RTL/mobile E2E; live Google/Microsoft linking; configured SMTP delivery; real streaming STT/TTS and telephony interruptions; tenant quota/billing flows; production monitoring; backup restore and deployment rollback. No production-readiness claim is made.


## Quota and call-admission evidence

The recorded run includes 10 quota integration cases, three signed call-admission cases and four quota policy unit cases. PostgreSQL concurrency tests verify exact admission ceilings, multi-meter rollback, inventory limits, duplicate settlement/release, cross-tenant denial, original-window settlement, provider failure/timeout/overrun behavior, subscription expiry without a quota reset, and MFA-protected overrides. Call registration, webhook event key, usage and quota debit commit atomically; failed quota admission can retry the same signed key after an override. Inactive/foreign agents cannot be assigned or executed.

Historical count correction: three live LLM cases previously returned early without credentials and were counted as passes. They now live in a separate `test:live:ai` acceptance command which requires an explicitly isolated disposable database and fails without configuration. They are NOT counted in the 364 tests. The unconfigured command's fail-closed startup was verified locally; no live provider acceptance is claimed.

The seven connected quota meters are calls, LLM input/output, embedding tokens, TTS characters, active agents and active tenant users. Voice minutes, STT minutes, physical storage inventory and orphan-reservation reconciliation remain incomplete. Provider-reported usage and conservative quota bounds are distinct; see ENTERPRISE-QUOTAS.md.
