# Enterprise validation report — 2026-10-04

## Last completed remote run

GitHub Actions [37186769147](https://github.com/engsaeedsajjadi/AI-Receptionist/actions/runs/37186769147), commit `42e285a3c2d0aba51d164ea3dfeffd0f8a37a341`:

| Check | Observed result |
| --- | --- |
| Lint / TypeScript | Passed |
| PostgreSQL 16 + pgvector migrations, run twice | Passed |
| Redis 7 / PostgreSQL integration and server-side E2E | Included in 350 passing tests, 49 files |
| Failed / skipped tests | 0 / 0 |
| Coverage lines/statements | 71.88% |
| Coverage branches / functions | 72.03% / 76.45% |
| Required 80% coverage | **Failed** |
| Next production build | Passed |
| Production dependency audit | Passed, zero reported vulnerabilities |

Overall workflow failed because coverage is below the required threshold. Thresholds have not been lowered. Server-side E2E does not constitute browser, telephony, live OAuth, payment, or deployment acceptance. Test doubles validate provider contracts, not external provider availability.

## New control-plane and billing changes

New integration cases cover tenant-admin denial, MFA enforcement, safe pagination, suspension, credential invalidation, idempotent state transitions, audit records, self-tenant protection, missing tenants, invalid payloads and administrator demotion. These cases passed in the recorded run. The same run passed billing calendar/catalog tests and real PostgreSQL integration tests for tenant isolation, operator-only settlement, request idempotency, concurrent settlement, reference-reuse rollback, amount mismatch, renewal, cancellation and expiry. No external bank/gateway was contacted or claimed successful.

## Remaining acceptance

80% measured coverage; browser accessibility/RTL/mobile E2E; live Google/Microsoft linking; configured SMTP delivery; real streaming STT/TTS and telephony interruptions; tenant quota/billing flows; production monitoring; backup restore and deployment rollback. No production-readiness claim is made.
