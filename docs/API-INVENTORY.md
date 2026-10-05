# API route inventory

Generated from source exports on 2026-10-04. Method-specific permissions and payloads remain defined by the routes and ENTERPRISE-API.md.

| Route | Methods |
|---|---|
| `/api/health/live` | GET |
| `/api/health/ready` | GET |
| `/api/health` | GET |
| `/api/metrics` | GET |
| `/api/v1/admin/maintenance` | POST |
| `/api/v1/agent/chat` | POST |
| `/api/v1/agents/[id]/activate` | POST |
| `/api/v1/agents/[id]/deactivate` | POST |
| `/api/v1/agents/[id]` | GET, PUT, DELETE |
| `/api/v1/agents/[id]/versions` | GET |
| `/api/v1/agents` | GET, POST |
| `/api/v1/appointments/[id]` | GET, PUT, DELETE |
| `/api/v1/appointments` | GET, POST |
| `/api/v1/auth/login` | POST |
| `/api/v1/auth/logout` | POST |
| `/api/v1/auth/logout-all` | POST |
| `/api/v1/auth/me` | GET |
| `/api/v1/auth/oauth/[provider]/callback` | GET |
| `/api/v1/auth/oauth/[provider]` | GET, POST |
| `/api/v1/auth/oauth/complete` | POST |
| `/api/v1/auth/recovery` | POST |
| `/api/v1/auth/refresh` | POST |
| `/api/v1/auth/register` | POST |
| `/api/v1/auth/security` | GET, POST |
| `/api/v1/auth/sessions` | GET, DELETE |
| `/api/v1/automation/dispatch` | POST |
| `/api/v1/automation/jobs` | GET, POST |
| `/api/v1/business` | GET, PUT |
| `/api/v1/business/settings` | GET, PUT |
| `/api/v1/calls/[id]` | GET |
| `/api/v1/calls/[id]/summary` | GET |
| `/api/v1/calls/[id]/transcript` | GET |
| `/api/v1/calls/[id]/transfer` | GET, POST |
| `/api/v1/calls` | GET |
| `/api/v1/crm/[entity]` | GET, POST, PATCH |
| `/api/v1/customers/[id]/history` | GET |
| `/api/v1/customers/[id]` | GET, PUT |
| `/api/v1/customers` | GET, POST |
| `/api/v1/files/[...key]` | GET |
| `/api/v1/knowledge/[id]` | GET, PUT, DELETE |
| `/api/v1/knowledge/reindex` | POST |
| `/api/v1/knowledge` | GET, POST |
| `/api/v1/knowledge/search` | POST |
| `/api/v1/knowledge/upload` | POST |
| `/api/v1/leads/[id]/assign` | POST |
| `/api/v1/leads/[id]/notes` | GET, POST |
| `/api/v1/leads/[id]` | GET, PUT, DELETE |
| `/api/v1/leads` | GET, POST |
| `/api/v1/notifications` | GET |
| `/api/v1/properties/[id]` | GET, PUT, DELETE |
| `/api/v1/properties` | GET, POST |
| `/api/v1/tools/properties/search` | POST |
| `/api/v1/usage` | GET |
| `/api/v1/users/[id]` | GET, PUT, DELETE |
| `/api/v1/users` | GET, POST |
| `/api/v1/webhooks/voice/audio` | POST |
| `/api/v1/webhooks/voice/call-ended` | POST |
| `/api/v1/webhooks/voice/call-started` | POST |
| `/api/v1/webhooks/voice/tool-call` | POST |
| `/api/v1/webhooks/voice/transcript` | POST |

## Platform additions

- `GET /api/v1/platform/tenants`: MFA-gated SUPER_ADMIN listing with cursor pagination.
- `PATCH /api/v1/platform/tenants`: audited suspension/reactivation; active sessions are revoked on suspension.

## Billing additions

- `GET, POST, PATCH, DELETE /api/v1/billing`: tenant-admin subscription/invoice management.
- `GET, POST /api/v1/platform/billing`: MFA-gated platform open invoices and payment reconciliation.
