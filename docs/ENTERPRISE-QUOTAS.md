# Quota implementation audit and design

Branch baseline: e326e227bf04d76d12016c3cb2ff3c8e461163d3. Existing manual subscriptions and invoice workflows are preserved. Existing `usage_records` records provider usage after execution; it cannot prevent concurrent overconsumption. Agent turns, call summaries, memory summaries, embedding ingestion/search and TTS all have separate provider invocation paths. Resource creation/activation also needs transaction-level admission.

## Design

Extend the existing PostgreSQL tenant boundary with tenant overrides, monthly meter buckets and an idempotent reservation journal. All mutations lock the existing business row. Multi-meter reservation checks and increments commit together. Provider execution occurs outside the transaction. Settlement/release updates the original window and is idempotent. Uncertain/crashed reservations remain held for investigation; no timer silently restores their allowance. Numeric quantities use four decimal places and integer arithmetic for accounting comparisons.

Global plan policies are explicit operator configuration (`QUOTA_PLANS_JSON`), never writable by tenant admins. Tenant-specific overrides require active SUPER_ADMIN, MFA, a reason and an audit record. Missing caps are explicitly unlimited for compatibility; this is visible in the API and is not represented as configured hard enforcement. Global policy plus tenant override resolves against the existing subscription's effective plan. Soft thresholds warn; hard thresholds plus explicit grace reject admission. Windows are UTC calendar months; inventory meters use a lifetime window.

Provider cost estimates are reservation bounds, not independently verified provider billing. LLM input uses a conservative UTF-8 bound and bounded output. Missing reported usage consumes the bound. Any provider-reported overrun is recorded honestly and fails the response; future admission sees the increased consumption. Provider-side charging for ambiguous failures cannot be undone by a local database transaction. End-to-end guarantees require verified provider bounds and call-duration control.

## Acceptance before marking phase COMPLETE

Concurrent exact-cap admission, atomic multi-meter rollback, tenant isolation, duplicate keys, duplicate settlement/release, month crossing, soft/grace thresholds, inactive tenant handling, override authorization/audit, provider failure and overrun tests. Every production consumption path must be connected and inventoried. Storage inventory/cleanup, call duration leases and all resource reactivation paths must pass integration tests before claiming all ten meters are enforced. No quota interface or disconnected meter alone constitutes completion.


## Current connected paths (PARTIAL phase)

- LLM input/output: agent iterations, conversation memory summarization, call summaries.
- Embedding tokens: ingestion/reindex batches and vector query embedding; successful batches settle independently.
- TTS characters: the voice-turn synthesis path.
- Active agents / active tenant users: creation, registration, and API reactivation; database inventory is counted under the same tenant row lock as the mutation. Inactive entries do not occupy a seat.
- Call count: signed call-started webhook admission, call row, usage record, quota debit and tenant-scoped webhook key commit atomically. Concurrent duplicate deliveries count once. Quota rejection rolls the key back for same-key retry. Calls are counted when admitted, including calls whose subsequent external answer/stream setup fails.
- Voice minutes, STT minutes and stored-byte inventory are **not yet fully connected**. The dashboard/API explicitly marks them unconnected. They are not represented as enforced merely because meter definitions exist.

`GET /api/v1/billing/quotas` returns plan, each meter's consumed/reserved quantities, window, hard/soft/grace policy, warning and connected state. It requires tenant-admin permission. `PATCH /api/v1/platform/quotas` accepts `{businessId,policy,reason}` and merges explicitly supplied meter overrides; it requires live SUPER_ADMIN + MFA and writes before/after audit data. Tenant admins cannot edit caps through business settings. A `hard:null` override explicitly makes that meter unlimited.

Example **test-only** global configuration: `QUOTA_PLANS_JSON={"FREE":{"llm_input_tokens":{"hard":100000,"soft":80000,"grace":0},"active_agents":{"hard":1}}}`. Choose actual commercial entitlements before deployment; omitted meters are unlimited. Deploy identical configuration on all workers/app instances. Existing monthly usage records are backfilled by migration 0013; inventory meters read the authoritative rows. No old usage is erased. Existing manual billing response keeps `quotasEnforced:false` until every required path is enforced and adds `enforcedQuotaMeters` for the connected subset.

Do not release reservations automatically on process restart or explicit provider timeout. Definitive rejected provider execution releases the reservation. If settlement fails after provider success, the reservation remains held. Operators must investigate orphan/uncertain reservations; the audited reconciliation UI described below is available. The system cannot reverse a charge already made by an external provider. Missing usage consumes the conservative bound; the quota ledger therefore differs from provider-reported cost estimates. Provider overruns are persisted/audited and return an error; finite input bounds must be validated against each supported model before claiming strict provider-billing guarantees.

Quota admission failures export `receptionist_quota_rejections_total{meter}` with a bounded meter label and no tenant/customer identifiers.

Disabled agents cannot execute through an explicit runtime agent ID or be assigned to new calls. This closes an active-agent entitlement bypass while retaining their editable configuration/history.

## Operator reconciliation

`/dashboard/quota-reservations` provides an explicit, MFA-gated SUPER_ADMIN workflow. `GET /api/v1/platform/quota-reservations` requires `businessId`, supports `after` UUID / `limit` (1–100), `status` and `olderThanSeconds`, and returns `data`, `hasMore`, `nextCursor`. Default filter is open reservations at least 15 minutes old. This makes held reservations visible; age is not proof of failed execution.

`POST` accepts `{businessId,id,action,reason,evidenceReference,executionStopped:true}`. `action:"settle"` requires `actual` with exactly the reservation's meter set. `action:"release"` requires `noUsageConfirmed:true`. Reasons need 10–1000 characters and evidence references 5–255 characters. Verify the provider's final state and stop/reconcile any outstanding executor before submitting. Use a non-secret request/ticket reference, not customer transcripts or credentials. The server cannot independently verify an operator assertion. The minimum reservation age is 15 minutes, not an automatic expiration.

Live platform/MFA authorization, tenant lock, original-window accounting and audit insert share a transaction. Suspended target tenants may be reconciled. Concurrent identical decisions debit once; conflicting finalizations return 409. Replaying an identical finalization does not add another audit event. Provider overruns remain consumed and audited. Missing accounting buckets fail closed without finalizing the journal. No automatic release or reset of monthly allowance occurs. Late conflicting provider settlement is rejected for investigation; completed history is never silently rewritten. Additional automated provider reconciliation remains unimplemented.

This change reuses existing reservation/bucket/audit tables; no migration is required.
