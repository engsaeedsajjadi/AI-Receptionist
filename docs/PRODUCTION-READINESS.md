# Production readiness — working gap ledger

Starting remote commit: `c12d9bc83367b5c554fa737c41202d1e5d09dbd1` on `enterprise/hardening-2026-10-03`. Local starting tree `e9066e10b20d5d84c44674db9f74cb5e35a4f021` matches that branch. This ledger applies the October 5 final-completion specification. It is a source-backed triage, **not an exhaustive tenant/security certification**. Historical audit documents describe earlier snapshots.

| Priority / area | Implementation / source evidence | Automated tests | Live validation | Status | Blocker |
| --- | --- | --- | --- | --- | --- |
| P0 coverage | `vitest.config.ts` includes library/API code, all four thresholds 80 | Last completed run: 364 passing; lines/statements 72.43%, branches 73.38%, functions 77.94% | Not applicable | FAIL | Meaningful missing-path tests; unchanged thresholds |
| P0 tenancy | `schema.ts`, migrations 0005–0013, request-context and platform services | Negative tenant cases exist | No production audit | PARTIAL | Full query/FK audit; nullable webhook ledger; formal RLS decision |
| P0 quotas | `services/quotas.ts`, `metered-ai.ts`, `call-admission.ts`: seven connected meters, row-locked accounting | Concurrency, rollback, window, tenant, inventory tests | Provider limits unverified | PARTIAL | Voice/STT/storage meters; operator reconciliation; provider bounds |
| P0 payment lifecycle | `services/billing.ts`: manual invoices and operator-recorded payments | Settlement, duplicate references, expiry/renewal | No gateway | PARTIAL | Automatic provider lifecycle, immutable refund/payment event ledger |
| P0 outbox | Migration 0009 durable jobs; call completion coupled to job | Worker/event tests exist | No crash/load drill | PARTIAL | Other domain events must share originating transactions |
| P0 telephony | `providers/voice.ts`: generic HTTP gateway, `voice/turn.ts`: STT/agent/TTS | Deterministic contract/media tests | No real call | BLOCKED | Concrete adapter, trusted duration enforcement; PSTN account and public WSS |
| P0 disaster recovery | Existing backup/restore scripts | No recorded isolated restore drill | None | FAIL | Restore workflow with fixture/migration/health verification |
| P0 release pipeline | `enterprise-ci.yml`: lint/types/migrations/tests/build/audit | Functional checks pass; coverage fails | No deployment | FAIL | Green CI, browser/secret/image scans, Docker boot/restore evidence |
| P1 RAG | `services/knowledge.ts`: indexed tenant documents, vector/keyword RRF; evidence injection | Retrieval and tool honesty tests | No evaluated live corpus | PARTIAL | ACL/versioning/metadata/reranker/analytics before model exposure |
| P1 identity/access | Existing sessions/MFA/OIDC/capabilities | Identity regression tests | OAuth/SMTP unverified | PARTIAL | Invitations, custom roles, API/service accounts, SSO/SCIM, cross-tab refresh, key rotation |
| P1 AI | Bounded tool loop, allowlists, versions, optional memory | Deterministic evals; explicit live command fails without config | None | PARTIAL | Typed intent, evaluated factual verification, governed memory and quality rubric |
| P1 storage/privacy | `providers/storage.ts`: local/S3 upload/read/delete/sign | Provider/key unit tests | No production storage | PARTIAL | Inventory/reconciliation/quotas, retention, export/anonymization/offboarding |
| P1 workflows/notifications/CRM | Durable jobs, notifications, pipelines/tasks | Integration tests exist | Delivery acceptance outstanding | PARTIAL | Configurable follow-ups, templates/scheduling, outbound webhooks, delivery ledger |
| P1 operations/security/UX | Platform pages, metrics/traces, Persian dashboard | Server tests only for recorded evidence | None | PARTIAL | Browser/RTL/accessibility, CSP, SLO/load/alerts, OpenAPI, exhaustive security/index/PII audit |
| P2 advanced/commercial | Existing provider abstractions and estimated costs | No complete acceptance | None | PARTIAL | HA/media scaling validation, WebRTC/noise/cloning, entitlements/branding and advanced analytics |

## Execution order

1. Close verifiable P0 defects without changing architecture: safe reservation investigation/reconciliation and tests; then remaining meters, tenant boundaries, outbox/payment lifecycle, restore and release checks.
2. Increase measured coverage with failure, concurrency and permission assertions. Do not exclude production code or silently skip missing infrastructure.
3. Implement P1 source/API/UI/test paths and only then non-destabilizing P2 work.

`quotasEnforced` remains false until all required paths are connected. A test double is not a live provider. Required external acceptance is **BLOCKED — external credentials/provider acceptance required**. No merge or deployment is authorized by this readiness document.
