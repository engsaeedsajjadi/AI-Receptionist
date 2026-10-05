# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **WhatsApp channel:** Meta Cloud API adapter with template and text modes, recipient
  normalisation, timeouts and verbatim provider errors, wired through the notification service
  and automation dispatch (credentials still required for live delivery).
- **Cross-tab session coordination:** BroadcastChannel bus so a logout or login in one tab
  updates the others without any cross-origin surface.
- **Load testing:** dependency-free budget-enforcing smoke harness plus a k6 staging soak
  script and runbook.
- **Billing lifecycle:** payment attempts/transactions/events, refund records, credit notes and
  subscription events with PENDING/SUCCEEDED/FAILED/EXPIRED/REFUNDED/PARTIAL/PAST_DUE/grace
  states, provider-agnostic `PaymentProvider` contract (checkout, verification, webhook parsing,
  refund, cancel/renew), expiry + past-due reconciliation and an immutable ledger.
- **Transactional outbox:** 15 domain topics written in the same transaction as their state
  change, with leases, exponential backoff, idempotency keys and dead-lettering; provider I/O
  never runs inside a database transaction.
- **Telephony:** concrete Twilio adapter (REST transport with aborts/timeouts, TwiML builders,
  HMAC webhook verification, media frame mapping) behind the existing generic voice provider,
  plus a media server with barge-in, VAD, DTMF handoff, capacity and idle guards.
- **RAG governance:** per-document ACL/governance metadata, version publishing and archive,
  governed search, retrieval analytics/evidence tracking, configurable reranking.
- **Identity/platform:** invitations, custom RBAC, tenant API keys (hash-only), service accounts,
  SCIM 2.0 users, OIDC SSO (PKCE/state/nonce + MFA), SAML configuration surface, secure
  time-boxed support sessions, tenant suspension/reactivation/deletion state machine.
- **Tenancy and privacy:** tenant request context, tenant-prefixed caches and storage keys, data
  export, retention policies, malware-scan adapter, `webhook_events.business_id NOT NULL`.
- **Voice/usage meters:** voice minutes, STT minutes and storage bytes accounting with
  reconciliation.
- **Observability/ops:** readiness/live probes, token-protected Prometheus metrics, OTLP tracing,
  Grafana provisioning, alert rules, SLO document, DR runbook with restore drill, migration
  safety gate.
- **Testing:** eight loud-failing live acceptance suites, Playwright Persian/RTL browser journeys
  with responsiveness + WCAG structural checks, and coverage above the 80% gate on all four
  metrics (90.10% statements/lines, 93.08% functions, 80.31% branches).

- **Provider circuit breakers:** per-provider breaker with exponential backoff, half-open
  probes, shared Redis state and an explicit health-vs-client error classifier, wired into the
  Twilio transport and the HTTP payment provider (`PROVIDER_CIRCUIT_OPEN` fails fast without
  calling the provider).

- **Prompt-injection red-team suite:** 15 deterministic cases covering override attempts,
  zero-width/RTL and markup payloads, prototype pollution through evidence JSON, denial
  detection with verbatim fallback, and the grounded-answer gate.
- **Index/query gate:** `scripts/ci/index-audit.mjs` (tenant-leading index coverage, hot-path
  indexes, forced-index plans) plus migration `0015` adding the two missing tenant indexes and
  `docs/INDEX-AUDIT.md` documenting the N+1 review.
- **Identity HTTP acceptance coverage:** `tests/integration/scim-routes.test.ts` (7) drives
  SCIM 2.0 end to end over HTTP (401/403 auth matrix, create + idempotent re-provision, list
  paging/filter with tenant isolation, PATCH, deactivate + audit row) and
  `tests/integration/oauth-routes.test.ts` (9) drives the OIDC surface (flow start, link with
  password, tampered/missing state, linked login with and without MFA, cross-tenant/duplicate
  link rejection, one-time MFA ticket with replay rejection, credential-version invalidation).
- **PII/secret log audit gate:** `scripts/ci/pii-log-audit.mjs` scans every structured log call
  site and fails on raw request bodies, credential keys or unmasked personal data; self-tested by
  `tests/unit/pii-log-audit.test.ts` and wired into CI.
- **White-labeling:** per-tenant product name, https logo, accent colour, support address, custom
  domain and platform-branding visibility behind the `whiteLabel` entitlement
  (`/api/v1/business/branding`, public host resolution, dashboard branding card + shell theming).
  The custom domain is a first-class unique column (migration `0016`), so a host can never resolve
  to two tenants; unknown, suspended or unentitled hosts get the platform branding, which keeps the
  endpoint useless for tenant enumeration.
- **Voice-cloning safety:** tenant-configured voice ids are gated by
  `src/lib/voice/voice-safety.ts` — publisher voices (and an operator allowlist) are allowed,
  anything else requires the platform opt-in plus a consent record scoped to the exact voice ids,
  recorded by an ADMIN through `/api/v1/business/voice-consent` and revocable at any time. The
  guard runs when the voice is configured and again at synthesis time, and the agent's configured
  voice is now actually used for speech (previously stored but never passed to the synthesizer).

### Changed

- Failed voice turns now return the caller to `LISTENING` instead of leaving the session stuck in
  `ERROR`.
- `updateProperty` validates input through `parseWith` and accepts nullish patches; appointment
  day schedules reject windows where start ≥ end; the property-code search pattern is
  Persian-safe.
- Reranker failures return 502 instead of silently emptying the evidence set.
- An MFA secret that cannot be decrypted (corrupt value, rotated `IDENTITY_ENCRYPTION_KEY`) now
  denies the login with 401 instead of surfacing a 500, on both the OAuth completion and the
  account-security paths; the failure is logged with the tenant id and no secret material.
- Partial workspace-feature updates no longer reset flags the caller did not send: the settings
  route merges feature flags field-by-field (the previous schema filled absent flags with their
  defaults, which could silently re-enable a disabled feature).

### Security

- Signed, timestamp-enforced voice webhooks, bounded streaming body reads, HMAC verification for
  tenant outbound webhooks, CSP/HSTS/COOP/CORP/permissions headers, MFA-protected platform
  operations, gitleaks + dependency audit + Trivy + SBOM in CI.

### Known limitations (Blocked — external)

- No real PSTN call has been placed; live payment gateway, SMTP, OAuth/SAML, object storage and
  production telemetry acceptance remain blocked on third-party credentials/infrastructure.
- Browser E2E and Docker image scanning execute in CI; they cannot run in this sandbox.
- WhatsApp, cross-tab refresh and load tooling are implemented but only smoke-tested locally;
  the white-labeling pipeline and a staging soak remain open.
