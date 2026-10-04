# Deployment and migration guide

Release status and verification limits are in ENTERPRISE-DELIVERY.md. Use staging before production.

## Configuration

Copy `.env.example` to an untracked `.env`. Local processes connect to `localhost`; Compose services connect to `postgres` and `redis`. Do not use `redis://redis:6379` for a Next.js process running directly on Windows. Set independent JWT/webhook secrets and a durable 64-hex-character IDENTITY_ENCRYPTION_KEY; back up that key separately, since losing it prevents MFA secret decryption. Generate secrets with a cryptographic random generator.

Production rejects dev AI/voice providers. Configure the generic telephony gateway, its credentials and public `wss://` media URL. Select configured LLM, embedding, STT/TTS and storage providers. Configure SMTP for account recovery. Configure n8n and its API key when automation is enabled. The worker consumes queued jobs; stopping it pauses delivery without deleting jobs.

Register OAuth redirect URIs exactly as `APP_URL/api/v1/auth/oauth/google/callback` and `APP_URL/api/v1/auth/oauth/microsoft/callback`. Microsoft requires a tenant GUID. Users first sign in with their password and link an identity under Security; matching an email never automatically links accounts.

## Upgrade

1. Back up PostgreSQL, object storage and encryption secrets; perform and verify a restoration to an isolated database.
2. Review `0005_tenant_messages.sql`: mismatched historical tenant references will cause migration failure. Correct these records based on ownership evidence; do not disable constraints to bypass the failure.
3. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run db:migrate` against staging. Repeat migration to verify idempotence.
4. Run the full test/coverage suite against an isolated test database and Redis. Tests truncate tables: **never point them at production**.
5. Build with `docker compose -f docker-compose.prod.yml build`. Configure TLS certificates referenced by nginx. Run the stack and verify liveness/readiness plus a real inbound voice journey.
6. Verify MFA/recovery, session revocation, tenant boundary tests, queue retry, provider webhooks and backup restoration before any production cutover.

Existing access tokens without a session identifier need refreshing/sign-in after upgrade. Refresh reuse revokes every session; clients must serialize refresh calls. The browser client does this within a tab; cross-tab coordination is an outstanding acceptance concern.

Custom composite constraints in SQL migrations are intentional and are not fully represented by generated Drizzle snapshots. Use reviewed migrations; **do not use db:push in production**. Rollback requires a forward fix or a tested backup restoration; dropping tables is not a safe rollback.

## Voice webhook migration

Production expects `x-webhook-signature: t=<unix-seconds>,v1=<HMAC-SHA256>` signed over the exact bytes `<unix-seconds>.<body>` and a stable `x-idempotency-key`. An unsigned separate timestamp header is insufficient. Keep retries inside the five-minute freshness window with a freshly signed timestamp and the same event identity. During key rotation, set VOICE_WEBHOOK_PREVIOUS_SECRET temporarily, switch gateways to the new key, then remove the previous key.

## Delivery semantics

Queue delivery is at least once. The remote receiver must honor the stable idempotency key because a crash after remote success and before local acknowledgement can repeat delivery. Leases prevent stale workers from acknowledging a newer claim. Failed jobs retain the error and attempts; tenant admins can retry dead jobs. Call completion uses a transactional outbox; other event sources and notification delivery still have documented crash windows.

## Observability

`/api/metrics` requires `Authorization: Bearer <METRICS_TOKEN>` and fails closed if the token is unset. Metrics expose status-class totals, request duration histograms and Node process metrics; they intentionally omit customer and tenant labels to avoid high cardinality and sensitive labels. Scrape each replica directly rather than through a load balancer.

The optional `docker-compose.monitoring.yml` overlay provisions Prometheus and Grafana. Set METRICS_TOKEN and GRAFANA_ADMIN_PASSWORD first. Grafana binds to localhost:3002; use an authenticated administrative tunnel or reverse proxy. Review and security-scan pinned images before deployment. Configure OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and optional OTEL_EXPORTER_OTLP_HEADERS for an existing trusted OTLP collector. Trace attributes contain request/tenant IDs but no prompts, tokens or transcript bodies. Metrics and trace export have unit coverage; a deployed collector/dashboard acceptance test remains required.

## Agent memory

Agent configuration supports `memoryEnabled` and `retrievalMode: tools|automatic`. These are opt-in to preserve existing inference behavior. Automatic retrieval runs tenant-scoped hybrid search before the model only when search_knowledge is allowed. Conversation memory summarizes after 30 messages and at least 20 new messages since the previous summary; it keeps a bounded rolling summary in call metadata and reads up to three previous summaries for the linked customer. It never matches unlinked customers by a claimed phone number. Summaries are lossy model output, not authorization evidence. Purging call records removes derived memory; deleting only the transcript does not purge its summary/metadata. Apply your retention policy to all three fields and stored recordings. The dashboard exposes model, temperature, tool permissions, retrieval and memory controls.

## Platform administrator bootstrap

Use a dedicated operator tenant. Register a user, verify email through SMTP and enroll MFA first. An infrastructure operator with database access can run `npx tsx scripts/platform-admin.ts <user-uuid>` to promote this exact existing account. The command rejects inactive/unverified/non-MFA accounts, records an audit entry and invalidates existing sessions. Sign in again using MFA, then open `/dashboard/tenants`. No tenant-facing endpoint grants SUPER_ADMIN. Keep database/operator access restricted. The panel supports tenant listing and suspension/reactivation; provisioning still uses the existing registration flow. Suspension blocks new authenticated requests and revokes credentials; it does not cancel already-running provider calls or delete retained data. Coordinate active call termination separately.
