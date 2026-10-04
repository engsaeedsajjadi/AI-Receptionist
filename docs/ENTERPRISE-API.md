# Enterprise API additions

Base URL: your configured APP_URL. Protected routes require `Authorization: Bearer <accessToken>`. Business identity is resolved from the active user/session; callers cannot choose another tenant with a header. Optional `x-tenant-id` must match the authenticated tenant. Responses carry request/trace IDs and `Cache-Control: no-store`. JSON errors use `error.code`, `error.message` and request ID. Validation failures are 400, unauthenticated 401, unauthorized 403, missing resources 404, conflicts 409, and rate limits 429.

## Identity

| Method / path | Input / behavior |
|---|---|
| POST /api/v1/auth/login | `{email,password,code?}`; code is TOTP/recovery when MFA enabled. Returns user/accessToken/refreshToken; also sets HttpOnly refresh cookie. |
| POST /api/v1/auth/refresh | Rotates refresh token; replay revokes all user sessions. Serialize refresh requests. |
| POST /api/v1/auth/logout-all | Authenticated session revocation across devices. |
| GET /api/v1/auth/sessions | Current user's sessions with device and timestamps; excludes token hashes. |
| DELETE /api/v1/auth/sessions | `{sessionId}`; revokes the selected device and its rotated descendants. |
| GET /api/v1/auth/security | Current MFA/email-verification/recovery-code status. |
| POST /api/v1/auth/security | `{action:setup|confirm|disable,password,code?}`. Setup returns enrollment secret. Confirm returns recovery codes once and invalidates sessions. Disable requires code or recovery code. |
| POST /api/v1/auth/recovery | `{action:request_reset,email}`; `{action:request_verification}` with auth; `{action:consume,token,purpose:password_reset|email_verify,password?}`. Links expire in 30 minutes and can be consumed once. |
| GET /api/v1/auth/oauth/{google|microsoft} | Redirect to configured OIDC provider for a linked account. |
| POST /api/v1/auth/oauth/{google|microsoft} | Authenticated `{password,code?}`; starts explicit external-account linking. |
| GET /api/v1/auth/oauth/{provider}/callback | OIDC authorization response. Validates browser-bound state, nonce and PKCE; subject/issuer mapping only. |
| POST /api/v1/auth/oauth/complete | `{code}` with HttpOnly challenge cookie; completes MFA after OAuth. Requires same-origin browser request. |

New passwords use versioned scrypt with random salt. Legacy bcrypt hashes remain readable; existing hashes migrate when passwords are changed/reset. A tenant administrator cannot create SUPER_ADMIN through user routes.

## Agent and knowledge

Agent creation/update accepts a `configuration` object: greeting, tone, language, businessInfo, systemInstructions, model (null means server default), temperature 0–2, allowedTools (null means all; [] means none), maxToolIterations 1–10, memoryEnabled and retrievalMode (`tools` or `automatic`). Configuration is validated and invalid stored configuration fails closed.

GET `/api/v1/agents/{id}/versions` returns the latest 100 configuration snapshots, tenant-scoped. Updating an agent writes its previous state in the same transaction. Activation endpoints are not yet versioned.

POST `/api/v1/agent/chat` accepts `{message,agentId?,callId?}`. A foreign call/agent is rejected before history access. Memory is available only with callId. Successful knowledge results are inserted as bounded, quoted evidence; evidence is not allowed to redefine system rules. Automatic retrieval uses the same tenant-scoped hybrid search as the knowledge tool. Summary-model consumption is recorded in usage records.

## CRM

GET `/api/v1/crm/{pipelines|opportunities|tasks}` returns `{data:[...]}` up to 100 records for the authenticated tenant.

- POST pipelines: `{name,stages:[...]}` with 2–20 unique stages. Stages are immutable; create another pipeline for a different process.
- POST opportunities: `{title,pipelineId,stage,value?,currency?,notes?,tags?,leadId?}`. Value is a decimal **string**, currency TOMAN/IRR/USD/EUR. Stage must belong to the selected tenant-owned pipeline.
- PATCH opportunities: `{id,stage}`.
- POST tasks: `{title,notes?,leadId?,assignedUserId?,dueAt?}`. Due time is ISO8601 with offset; related records must belong to the tenant.
- PATCH tasks: `{id,status:OPEN|DONE|CANCELLED}`.

## Automation and operations

GET `/api/v1/automation/jobs` lists tenant jobs for a manager/admin. POST `{id}` retries an exhausted job for a tenant administrator. Delivery is at least once, with a stable idempotency key passed to the receiver. Worker: `npm run worker`.

GET `/api/metrics` uses a separate `METRICS_TOKEN` bearer credential. It exposes process-wide metrics and is not a tenant API. Do not share this token with tenant users. Liveness/readiness remain `/api/health/live` and `/api/health/ready`.

The accompanying API inventory lists every route/method present in the source. It is an inventory, not a generated complete OpenAPI request schema or proof of live provider acceptance.

## Platform tenant administration

`GET /api/v1/platform/tenants?limit=30&after=<uuid>` returns `{tenants,nextCursor}` with a safe projection (id, name, slug, active state, creation date), maximum 100 rows. `PATCH` accepts `{id,isActive,reason}`; reason must contain 10–1000 characters. Both require a live, active `SUPER_ADMIN` with enrolled MFA. Tenant roles cannot use these endpoints. The service independently revalidates database privileges. Own-tenant state changes return 409. Suspension atomically changes tenant state, increments every user's credential version, revokes sessions, and writes an audit event in the affected tenant. Repeating the same state is a no-op. Reactivation requires new login; it never resurrects revoked sessions. This is a deliberate, narrowly scoped control-plane exception to normal tenant-only reads. No impersonation or tenant data export is provided.
