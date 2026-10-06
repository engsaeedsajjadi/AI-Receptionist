# Index audit and query plans

Run by CI on every validation job (`node scripts/ci/index-audit.mjs`, after both migration
runs). It fails the build on a regression instead of reporting one.

## Rules enforced

1. **Every tenant-scoped table has a tenant-leading index.** For each table with a
   `business_id` column, at least one index must have `business_id` as its *leading* column —
   otherwise tenant filtering degrades to a sequential scan as data grows. 50 tenant tables are
   checked.
2. **Hot-path indexes must exist:**

   | Table | Index | Why |
   | --- | --- | --- |
   | `api_keys` | `api_keys_hash_idx`, `api_keys_prefix_idx` | API-key authentication runs on every request |
   | `knowledge_chunks` | `knowledge_chunks_embedding_hnsw_idx` | pgvector cosine search |
   | `knowledge_chunks` | `knowledge_chunks_content_trgm_idx` | trigram keyword search |
   | `properties` | `properties_location_trgm_idx` | trigram location search |
   | `webhook_events` | `webhook_events_tenant_idx` | per-tenant idempotency ledger |
   | `outbox_events` | `outbox_events_pending_idx` | worker leases pending events |
   | `quota_reservations` | `quota_reservations_pending` | reservation expiry sweep |
   | `refresh_tokens` | `refresh_tokens_jti_idx` | rotation looks tokens up by `jti` |
   | `calls` | `calls_business_created_idx` | tenant-scoped, created-at-ordered call list |

3. **Query plans.** Three representative tenant queries are `EXPLAIN`ed (never
   `EXPLAIN ANALYZE`, which would execute them against live data). The natural plan is logged
   for visibility; the *assertion* re-runs each query with `enable_seqscan = off` inside a
   rolled-back transaction, so on an empty CI database we still prove an index path exists on
   the tenant-scoped table.

## Remediation applied

`payment_events` and `refresh_tokens` were the only tenant tables without a tenant-leading
index. Migration `0015_tenant_index_audit` adds:

- `payment_events_tenant_created_idx (business_id, created_at DESC NULLS LAST)` — the payment
  webhook ledger is read per tenant in reverse chronological order;
- `refresh_tokens_tenant_user_idx (business_id, user_id)` — session administration lists and
  revokes tokens per tenant/user.

Migration `0016_white_label_domain` adds the white-labeling domain lookup index:

- `businesses_custom_domain_idx` — **unique** on `custom_domain`, so two tenants can never
  resolve to the same host and host-based branding lookup is an index probe, not a scan
  (NULL is allowed many times, which is the "no custom domain" state). The index is declared in
  `src/db/schema.ts`, so `drizzle-kit generate` stays in sync with the database.

## N+1 audit (current state)

- List endpoints fetch parent rows and then batch-load relations with `inArray(...)`; the
  dashboard contracts suite (`tests/integration/dashboard-contracts.test.ts`) asserts the
  response shapes, and services avoid per-row queries inside loops.
- Known deliberate exceptions: per-tenant maintenance sweeps (retention, quota reconciliation)
  iterate tenants by design — they run in the worker, not in a request path.
- No unbounded `select()` without a `business_id` predicate exists outside the MFA-gated
  platform control plane (see `docs/TENANT-ISOLATION.md` for the enforcement chain).
- PII logging: the logger redacts known PII keys (phone, email, password, token, secret) and no
  request/response bodies are logged; the redaction is exercised by the logger unit suite **and**
  enforced statically by `scripts/ci/pii-log-audit.mjs` (CI step 7b), which fails on raw request
  bodies, credential keys, or personal-data keys that are not masked/hashed/reduced.
