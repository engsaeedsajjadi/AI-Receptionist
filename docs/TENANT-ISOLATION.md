# Tenant isolation — audit evidence and formal RLS decision

Root tenant identity is `businesses.id`; every tenant-scoped table carries a `business_id`
boundary column. No parallel tenant hierarchy exists. This document records the audit
evidence and the **formal decision about PostgreSQL row-level security (RLS)**, as required
by the completion specification.

## Decision: no RLS rollout; application-enforced tenant context plus database constraints

PostgreSQL RLS is **not** enabled. The decision is deliberate:

- **Why:** every query in this codebase is issued through Drizzle against a connection pool
  that is shared by all tenants. Introducing RLS without a transaction-local
  `SET LOCAL app.current_business_id` on *every* connection checkout would either be a no-op
  (policies keyed on a session variable that is never set → all rows hidden, production
  outage) or a security theatre (variable set per request but leaking across pooled
  connections). The application-layer context is already established *before* any query runs
  (`requestContext` AsyncLocalStorage), so the equivalent safeguard must be enforced at that
  layer and at the schema layer.
- **Equivalent safeguards in force** (see the enforcement chain below): composite foreign
  keys that make cross-tenant rows unrepresentable, `business_id NOT NULL` on every scoped
  table including the webhook idempotency ledger, tenant-scoped unique indexes, tenant
  context bound per request with a hard failure when a service is called without scope,
  tenant-prefixed cache keys, tenant-prefixed storage keys, tenant-filtered vector queries,
  and negative cross-tenant tests for every service boundary.
- **Revisit trigger:** if the platform ever adopts per-tenant database roles or
  `SET LOCAL` connection pinning for every request, RLS can be added on top of these
  constraints without changing the service layer. The decision is therefore reversible and
  documented, not dropped.

This is explicitly *not* a claim that isolation is certified. The audit below is
source-derived and test-backed; a production audit against live data remains a release
activity.

## Enforcement chain (source evidence)

| Layer | Mechanism | Evidence |
| --- | --- | --- |
| Request identity | `requestContext` AsyncLocalStorage; `bindTenantContext()` / `assertTenantScope()` fail closed when a tenant-scoped service is reached without a bound tenant | `src/lib/request-context.ts`, `src/lib/auth.ts` |
| Schema | Composite `(id, business_id)` unique keys and composite foreign keys; `business_id` on every scoped table | `src/db/schema.ts`, migrations `0005`–`0014` |
| Webhook ledger | `webhook_events.business_id` is `NOT NULL`; the legacy nullable global-scope rows were removed by migration `0014` | `drizzle/0014_massive_micromax.sql` |
| Querying | Every service filters by `business_id`; cross-tenant ids resolve to `*_NOT_FOUND`, never to another tenant's row | `src/lib/services/*.ts` |
| Vector search | pgvector queries join `knowledge_chunks` → `knowledge_documents` and filter `kc.business_id = $1` | `src/lib/services/knowledge.ts` |
| Cache | `tenantCacheKey(businessId, namespace, key)` → `business/<id>/<namespace>`; no global key for tenant data | `src/lib/tenant-cache.ts` |
| Storage | Keys are tenant-prefixed and validated by `assertSafeKey` (no traversal, no absolute paths) | `src/lib/providers/storage.ts` |
| Quotas/meters | Every meter row is keyed by `business_id` with `FOR UPDATE` row locks; missing tenant is a hard error | `src/lib/services/quotas.ts`, `call-admission.ts`, `voice-usage.ts`, `storage-usage.ts` |
| Notifications/outbox | Enqueued with `payload.businessId` inside the originating transaction; delivery re-validates the tenant | `src/lib/services/outbox.ts`, `notifications.ts` |
| Platform ops | Cross-tenant reads exist only behind `requirePlatformAdmin` (SUPER_ADMIN + MFA) and are audit-logged | `src/lib/auth.ts`, `src/app/api/v1/platform/**` |

## Test evidence (executed)

- `tests/integration/tenant-isolation.test.ts` — 11 negative cases: tenant B cannot read
  tenant A's leads, customers, properties, calls, knowledge chunks, users; foreign keys
  reject cross-tenant relationships; scoped writes stay inside their tenant.
- `tests/integration/tenant-webhooks.test.ts`, `tests/integration/webhooks.test.ts`,
  `tests/integration/webhook-routes.test.ts` — unsigned/forged webhooks are rejected
  (fail fast, never fail open), replay is refused, `webhook_events` rows cannot be written
  without a tenant.
- `tests/integration/enterprise-security.test.ts`, `tests/integration/access-control.test.ts`,
  `tests/integration/rbac.test.ts` — authentication/authorization boundaries, capability
  roles, MFA gates.
- `tests/integration/call-quota.test.ts`, `tests/integration/quota-reconciliation.test.ts` —
  quotas never fail open on a missing tenant; reconciliation cannot overshoot.

Run them with a disposable database:

```bash
source /home/user/.cache/ci-env.sh   # or export TEST_DATABASE_URL yourself
npx vitest run tests/integration/tenant-isolation.test.ts tests/integration/tenant-webhooks.test.ts
```
