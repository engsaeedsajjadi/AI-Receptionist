# Database tenancy and migration notes

Tenant root: `businesses.id`. All operational data belongs to a business; the schema intentionally does not introduce a second tenant hierarchy.

| Table | Scope |
|---|---|
| `businesses` | Tenant root |
| `users` | business_id |
| `agents` | business_id |
| `customers` | business_id |
| `leads` | business_id |
| `lead_notes` | business_id |
| `calls` | business_id |
| `call_messages` | business_id |
| `knowledge_documents` | business_id |
| `knowledge_chunks` | business_id |
| `appointments` | business_id |
| `notifications` | business_id |
| `automation_dispatches` | business_id |
| `usage_records` | business_id |
| `refresh_tokens` | business_id |
| `properties` | business_id |
| `webhook_events` | Webhook infrastructure ledger; business_id nullable (remaining hardening item) |
| `audit_logs` | business_id |
| `identity_tokens` | business_id |
| `agent_versions` | business_id |
| `automation_jobs` | business_id |
| `oauth_accounts` | business_id |
| `crm_pipelines` | business_id |
| `crm_opportunities` | business_id |
| `crm_tasks` | business_id |

Migrations 0004–0011 add session metadata, call-message tenant keys, role enum values, identity/MFA fields, identity tokens, agent versions, automation jobs, OAuth account links and CRM pipeline/task/opportunity tables.

Composite foreign keys reject cross-tenant relationships. Nullable links retain the existing ON DELETE SET NULL behavior; deferred constraints validate the resulting relationship at transaction commit. Some application tables still need a complete FK/RLS audit. PostgreSQL row-level security has not been introduced; application predicates and constraints are the current boundary.

The schema stores MFA secrets encrypted with AES-GCM and user-specific associated data; recovery/reset/refresh secrets are hashed. Encryption keys are not stored in the database. `agent_versions.snapshot` and call metadata/transcripts require the same access/retention controls as primary customer data.

Review SQL migrations rather than using db:push in production. Custom deferred constraints are intentionally migration-owned. The migration runner pins its advisory-lock connection; migrations are serialized. Back up before migrating and test restore/upgrade against historical records. Tests truncate tables and must use isolated test databases.
