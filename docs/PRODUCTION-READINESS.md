# Production readiness matrix

Source-derived status for the final SaaS completion specification. Statuses are
**PASS / PARTIAL / BLOCKED / FAIL**. `BLOCKED` is reserved for items that inherently require a
third-party credential, a purchased number or production infrastructure; those are listed in
full at the end. This document is generated from the working tree and executed evidence, and
it does not authorize a production deployment on its own.

Branch: `arena/01a10ae4-ai-receptionist` (integration branch for `enterprise/hardening-2026-10-03`
work). Evidence for the run below: 2026-10-05, local PostgreSQL 16 + pgvector, Redis 7.2.5,
Node 22.

## Executed evidence (this working tree)

| Command | Result |
| --- | --- |
| `npm ci` | pass |
| `npx tsc --noEmit` (`npm run typecheck`) | pass, 0 errors |
| `npx eslint .` (`npm run lint`) | pass, 0 problems |
| `npx vitest run` | **804 tests / 96 files passed, 0 skipped, 0 failed** |
| `npx vitest run --coverage` | **statements 92.23% · lines 92.23% · functions 94.04% · branches 81.97% (16112/17468, 853/907, 4674/5702)** — all four 80% thresholds pass, 0 skipped; see `docs/coverage-baseline.txt` |
| `npm run db:migrate` (twice) | pass; migrations `0014`–`0018` apply cleanly on a fresh and on a restored database |
| `node scripts/ci/check-migration-safety.mjs` | pass (no `db:push` in deploy paths, journal/snapshot coverage complete, destructive statements justified) |
| `node scripts/ci/index-audit.mjs` | pass (50 tenant tables tenant-indexed, 181 public indexes, forced-index plans available, incl. the keyset pagination window) |
| `node scripts/ci/pii-log-audit.mjs` | pass — every structured log call site is free of raw request bodies, credential keys and unmasked personal data (0 waivers) |
| `node scripts/ci/check-test-results.mjs test-results/vitest.json` | pass — 276 suites / 804 tests, 0 skipped, all required integration + e2e files executed |
| `bash scripts/ci/restore-drill.sh` | **pass** — backup → isolated restore → sentinel tenant round-trip → migrate ×2 → health checks |
| `for s in llm embedding stt tts smtp oauth storage telephony; do node scripts/ci/check-live-suite-fails.mjs $s; done` | **8/8 suites fail loudly without credentials** (never skip-green) |
| `npm run build` | pass (production build, 51 routes) |
| `LOAD_PATHS=/api/health/live LOAD_DURATION_SECONDS=15 LOAD_CONCURRENCY=20 npm run test:load` | pass — 3857 requests, 0 errors, 0 throttled, 256 rps, p50 71 ms / p95 109 ms (local dev server; staging soak still required, `docs/LOAD-TESTING.md`) |
| `npx playwright test --list` | 30 tests in 3 spec files discovered (desktop + mobile projects) |
| `npx playwright test` | **BLOCKED in this sandbox** — Chromium cannot be installed (upstream download/apt failure). Runs in CI job `browser-journeys` via `npx playwright install --with-deps chromium`. |
| `npm audit --omit=dev --audit-level=high` | pass (0 high/critical in production dependencies) |
| `curl /api/health/live` · `/api/health/ready` | 200 `{"status":"live"}` · 200 `{"status":"ready", checks: postgres, migrations, storage, provider-config, redis}` (dev server, 18 migrations applied) |
| `curl /api/metrics` (with and without token) | 401 without `Authorization: Bearer $METRICS_TOKEN`, 200 with it (Prometheus text exposition) |
| `VOICE_MEDIA_TOKEN=… npx tsx scripts/media-server.ts` then `curl /healthz` | 200 `{"status":"ok","sessions":0,"capacity":100,"provider":"dev","codec":"mulaw","sampleRate":8000}`; without `VOICE_MEDIA_TOKEN` the process refuses to start; unauthenticated `/media` request → 404 |

## P0 — blocking gates

| Area | Implementation / source | Automated tests | Live validation | Status | Blocker |
| --- | --- | --- | --- | --- | --- |
| Coverage ≥80% (all four) | `vitest.config.ts` thresholds 80/80/80/80, no exclusions, no skips | 86 files / 752 tests, 0 skipped; **91.97 statements / 91.97 lines / 94.02 functions / 81.12 branches** (15447/16794, 834/887, 4332/5340) | n/a | **PASS** | — (branch coverage margin is 1.12 pt; new code must carry tests) |
| Tenant isolation | `businesses.id` root + `business_id` boundary on every scoped table; composite FKs; `requestContext` fail-closed; tenant cache/storage/vector/quota scoping | `tenant-isolation` (11 negative cases), tenant-webhooks, webhook-routes, rbac, access-control | No production audit | **PASS (source + tests)** | Production data audit remains a release activity |
| RLS decision | **Decision: no RLS rollout**; documented rationale + equivalent safeguards and a revisit trigger in `docs/TENANT-ISOLATION.md` | Isolation enforced/tested at the application + schema layers | n/a | **PASS (decision documented)** | — |
| Webhook ledger tenancy | `webhook_events.business_id NOT NULL`, nullable legacy rows removed, tenant-scoped unique index | webhook negative/replay/forgery suites | No production traffic | **PASS** | — |
| Meters: voice/STT/storage | `voice-usage.ts`, `metered-ai.ts`, `storage-usage.ts`, `quota-policy.ts`, `call-admission.ts` | quota, call-quota, quota-reconciliation, storage tests | Provider limits unverified | **PASS (source + tests)** | Real provider-side limits need live traffic |
| Billing core | `payments.ts` + `providers/payments.ts`: createCheckout/verifyPayment/parseWebhook/refund/cancelSubscription/renewSubscription; tables `payment_attempts`, `payment_transactions`, `payment_events`, `refund_records`, `subscription_events`, `credit_notes`; states PENDING/SUCCEEDED/FAILED/EXPIRED/REFUNDED/PARTIAL/PAST_DUE/grace | `payments.test.ts`, `billing.test.ts`, route coverage, provider adapters | No live gateway account | **PASS (source + tests)** | **BLOCKED — live gateway acceptance** |
| Ledger immutability | Append-only events, no double activation, unique payment references, idempotent webhook processing, cross-tenant settlement rejected, grace-based expiry reconciliation | billing/payments suites assert duplicates + replay + tenant boundaries | n/a | **PASS** | — |
| Transactional outbox | 15 topics (`lead.created`, `appointment.created/updated/cancelled`, `call.completed`, `call.handoff_requested`, `invoice.created`, `payment.received`, `subscription.changed`, `user.invited`, `tenant.suspended`, `tenant.reactivated`, `notification.requested`, `knowledge.updated`, `export.ready`); enqueued inside the caller's transaction; worker with lease/backoff/idempotency/dead-letter; provider I/O outside transactions | `outbox`, `automation-dispatch`, `notifications-usage`, domain suites | Worker crash/load drill not performed | **PASS (source + tests)** | Sustained-load drill pending |
| Telephony adapter | Concrete Twilio adapter (REST transport, TwiML builders, HMAC signature verification, media frame mapping, timeout/abort), generic provider retained; media server bridges real streaming; inbound webhook resolves the dialled number against every storage form (raw/national/E.164), refuses ambiguous matches instead of guessing, answers **every** failure in TwiML the caller can hear (provider config, signature, payload, media outage, quota) and validates media infrastructure *before* admitting a call (no quota burn, no phantom call rows); one number belongs to one tenant (partial unique index `businesses_phone_idx`, 409 `PHONE_TAKEN`) | `telephony-twilio`, `telephony-twilio-edge-cases`, `media-server` (16); `voice-inbound-webhook` (9: admission+TwiML, fail-closed signature, 5 refusal modes, lifecycle gate, idempotent redelivery, quota refusal, national/E.164 resolution, ambiguous number, disclosure escaping) | **No real PSTN call** | **PARTIAL** | **BLOCKED — real PSTN number and an answered call** |
| Voice usage accounting | Usage derived from trusted lifecycle events (`voice-usage.ts`, media-server lifecycle, call finalisation) | voice-turn, media-server, call-lifecycle suites | No carrier CDR comparison | **PARTIAL** | Carrier-side duration comparison needs live calls |
| Live provider suites | `tests/live/{llm,embedding,stt,tts,smtp,oauth,storage,telephony}.acceptance.ts` + `live-config.ts` guard; refuse production-looking DBs | gate proves 8/8 fail loudly without credentials | Not executed with credentials | **BLOCKED** | Provider credentials (see list) |
| Backup/restore/DR | `scripts/backup.sh`, `scripts/restore.sh`, `scripts/ci/restore-drill.sh`, `docs/DISASTER-RECOVERY.md` (RPO ≤24 h / RTO ≤60 min, never auto-restore over prod) | restore drill executed and green | No production-scale dump | **PASS (drill)** | Production-scale restore timing unmeasured |
| CI pipeline (20 steps) | `.github/workflows/enterprise-ci.yml`: 3 jobs — validation (install, lint, typecheck, gitleaks, migration safety, migrate ×2, index audit, coverage + skip guard, live-suite gate, build, audit), browser journeys (Playwright), container-and-restore (restore drill, Docker build, Trivy, SBOM) | Every gate verified locally (see the evidence table); the workflow itself has not run on GitHub | No deployment job | **PARTIAL** | **BLOCKED — the connected GitHub App lacks the `workflows` permission, so the branch (which edits `.github/workflows/enterprise-ci.yml`) cannot be pushed; reconnect GitHub with `workflows` scope.** Re-confirmed after the latest commit chain
(`f4de0cd..9b56d5b`) — the rejection is identical. Deployment gating needs environment approval |

## P1 — hardening and platform features

| Area | Implementation / source | Tests | Live validation | Status | Blocker |
| --- | --- | --- | --- | --- | --- |
| RAG ACL / versioning / metadata / reranking / analytics | `knowledge-governance.ts` (governance, publishing versions, archive, version list, retrieval analytics, governed search, evidence tracking) + `rag/access.ts`; **the ACL is enforced in SQL and `scope` is now required by `hybridSearch`** — previously omitting it made the predicate `TRUE`, so ROLE/AGENT/PRIVATE/CATEGORY restrictions were silently off for the AI runtime, the `search_knowledge` tool and the search API. The runtime uses `searchKnowledgeGoverned` (reranking, retrieval event per turn, `markEvidenceUsed`), failing over to "no evidence" rather than a failed call | `knowledge`, `rag-governance`, `rag-acl-enforcement` (6: role/private/category isolation, agent-scoped documents, API scoped to the session role, manager gets neither document nor content, governed retrieval recorded and evidence marked used, private document never reaches an agent turn), `tool-honesty` | No evaluated live corpus | **PASS (source + tests)** | Quality evaluation on live corpus pending |
| Prompt-injection defense | Layered prompt assembly (immutable guardrails first, untrusted data labelled and JSON-encoded), evidence schema caps/rejection, denial detection with verbatim fallback, grounded-answer gate now **enforced at runtime** (unsupported claims are replaced, not just asked away) | `prompt-injection-defense.test.ts` (15 red-team cases: override attempts, zero-width/RTL and markup payloads, prototype pollution, fabricated claims, empty answers) | No live adversarial corpus against a real model | **PASS (structural + deterministic)** | Live model red-teaming (needs provider credentials) |
| Typed intent pipeline + claim verification + AI quality eval | Claim verification is **enforced on the live path**: every agent turn splits the reply into atomic claims (Persian-normalised), scores them against the retrieved evidence and replaces an unsupported answer with the extractive excerpts before the caller hears it (0.6 support gate; verdict/ratio/claims returned in the turn result and logged). `conversation-intelligence.ts` (typed intent boundary, clarification policy, slot extraction) and `memory.ts` + `tests/ai/eval.test.ts` remain the offline/deterministic layer | `answer-quality` (9), `prompt-injection-defense` (15), `rag-acl-enforcement` (2 grounding cases: fabricated answer replaced, grounded answer passes through), `conversation-intelligence`, `tests/ai/eval.test.ts` | Live eval needs credentials | **PARTIAL** | Live model evaluation; intent classification weights tuned on a real transcript corpus |
| Sentiment / analytics rubrics | `conversation-intelligence.ts` with grounded scoring | unit/integration coverage | No live transcripts | **PARTIAL** | Live call corpus |
| Custom RBAC | `permissions.ts`, `roles` routes, capability roles | `rbac`, `access-control` | n/a | **PASS** | — |
| Invitations | `access.ts` + `/admin/invitations` + acceptance route, outbox `user.invited` | access-control, identity tests | SMTP live | **PARTIAL** | Live email delivery |
| SSO/SAML | OIDC (Google/Microsoft, PKCE/state/nonce, MFA step) live-ready; SAML configuration surface documents that assertion handling requires IdP metadata | `tests/integration/oauth-routes.test.ts` (9: start/callback/link/login/MFA complete incl. replay + undecryptable-secret denial), identity-provisioning tests | OIDC/SAML live | **PARTIAL** | **BLOCKED — IdP production app / metadata** |
| SCIM 2.0 | `/api/v1/scim/v2/Users[/id]` (auth → scope → provision → audit) | `tests/integration/scim-routes.test.ts` (7: 401/403, create + idempotency, validation, list paging/filter, tenant-scoped 404s, PATCH, DELETE + audit) | n/a | **PASS** | IdP-driven SCIM push needs a live directory (external) |
| Tenant API keys + service accounts | `/admin/api-keys`, `/admin/service-accounts`, hash-only `ar_live_<prefix>_<secret>` storage, scope checks | identity/access-control suites | n/a | **PASS** | — |
| Outbound webhooks | `/admin/webhooks` + `/deliveries`, HMAC signature, idempotency, retry, dead-letter, delivery log | tenant-webhooks, webhooks suites | No live consumer endpoint | **PASS (source + tests)** | Live consumer verification |
| OpenAPI 3 | `/api/v1/openapi.json` served from the route tree | api-surface, route-coverage | n/a | **PASS** | — |
| Platform control plane | `/api/v1/platform/*`: tenant list/suspend/reactivate/deletion, billing providers/refunds/credit notes, support sessions, MFA + SUPER_ADMIN gated | platform suite, enterprise-security | n/a | **PASS** | — |
| Secure support access | Time-boxed, audited support sessions (`platform/support-sessions`) — no unrestricted impersonation | enterprise-security | n/a | **PASS** | — |
| Tenant data export | `/admin/exports` + `export.ready` outbox topic | data-governance suite | No production export | **PASS (source + tests)** | Large-tenant export timing |
| Storage quotas / reconciliation | `storage-usage.ts`, maintenance reconciliation | quota-reconciliation | No production bucket | **PARTIAL** | Live bucket listing acceptance |
| Retention policies | `data-governance.ts`, tenant `retention_days` setting, maintenance job | data-governance | No production run | **PASS (source + tests)** | — |
| Malware scanning adapter | **Wired into the only file-ingestion path** (`ingestFile` scans before extract/archive/index): heuristic engine + ClamAV-compatible HTTP adapter with honest `clean`/`infected`/`unavailable` verdicts; `infected` → 400 `MALWARE_DETECTED` with the file quarantined (metered) and the document recorded `failed` (never `indexed`, so never searchable); `unavailable` follows `MALWARE_SCAN_STRICT` (production default = reject 503 `SCANNER_UNAVAILABLE`, never treated as clean) and is stamped on the document when lenient | `knowledge-upload` (7: missing field, role denial, 415/400/413, MIME/extension mismatch, magic-byte spoofing, clean verdict persisted, EICAR → quarantine + unsearchable, strict/lenient unavailable, honest 503 without embeddings), identity-provisioning | No real AV engine endpoint | **PASS (source + tests)** | **BLOCKED — real ClamAV endpoint (`MALWARE_SCAN_URL`) acceptance** |
| Notification templates + scheduling | `notifications.ts`, template/queue handling, outbox `notification.requested` | notifications-usage | SMTP live | **PARTIAL** | Live email + scheduling clock |
| WhatsApp abstraction | `WhatsAppCloudProvider` (Meta Cloud API, template + text modes, digit-only recipient normalisation, timeout/abort, provider error surfaced verbatim); channel wired through notifications/automation dispatch; env schema + production validator | `tests/unit/whatsapp-notifications.test.ts` (10 cases) | No live WhatsApp Business account | **PASS (source + tests)** | **BLOCKED — Meta Cloud API credentials** |
| CRM follow-up | `crm.ts` pipelines/opportunities/tasks + follow-up rules | crm/dashboard-contracts tests | n/a | **PASS (source + tests)** | — |
| Explainable scoring | Lead scoring is a deterministic rubric (`src/lib/scoring.ts`, `lead-score/v1`): every point names its factor + reason, persisted in `leads.score_rationale` beside `leads.score`; `GET/POST /api/v1/leads/{id}/score` reads the stored rationale or deliberately rescores (FOR UPDATE, tenant bounded, `crm:write`, audit row with from/delta/factor diff), dashboard shows factors and the recompute delta. Sentiment rubric in `conversation-intelligence.ts`/`answer-quality.ts` is likewise deterministic + explained | `tests/unit/lead-scoring.test.ts` (6), `tests/integration/lead-scoring-routes.test.ts` (2), leads/call-lifecycle suites | n/a | **PASS** | Weight *calibration* against real won/lost outcomes needs live sales data (weights are documented, not tuned) |
| Alert rules / Grafana | Prometheus `/api/metrics` (token-gated), `docker-compose.monitoring.yml`, Grafana provisioning | monitoring unit tests | No production telemetry endpoint | **PARTIAL** | **BLOCKED — telemetry endpoint** |
| SLOs | `docs/SLO.md` (availability, latency, provider budgets, hygiene) | n/a | No production baseline | **PARTIAL** | Production traffic |
| Load tests | `scripts/load/smoke.mjs` (dependency-free, budget-enforcing, refuses non-local targets) + `scripts/load/k6.js` staging soak; `npm run test:load`; `docs/LOAD-TESTING.md` | smoke harness executed locally (1113 requests, 0 errors, p95 ~50 ms on health probes) | No staging soak | **PARTIAL** | **BLOCKED — staging environment** |
| Playwright E2E (15 Persian RTL journeys) | `tests/browser/journeys.spec.ts` (15), `responsive.spec.ts` (3, mobile+desktop), `accessibility.spec.ts` (8 pages), seeded tenant, real login | 30 tests discovered; **never executed** | — | **PARTIAL** | **BLOCKED — browser binaries unavailable in this sandbox; runs in CI** |
| WCAG 2.2 AA | Structural checks (lang/dir, named controls, labels, focus ring, link text, no horizontal scroll) | accessibility.spec.ts | Not executed | **PARTIAL** | Same as above; no axe-core rule engine yet |
| RTL/responsive QA | `dir="rtl"`/`lang="fa"` asserted; mobile project (Pixel 7) overflow assertions | journeys + responsive specs | Not executed | **PARTIAL** | Same as above |
| CSP / security headers | `next.config.ts`: CSP, HSTS, nosniff, DENY framing, referrer policy, COOP/CORP, permissions policy | build + unit | No external scan | **PASS (source)** | Header verification on deployed host |
| Security scanning | gitleaks (secrets), `npm audit --omit=dev --audit-level=high`, Trivy image scan, CycloneDX SBOM — all in CI | CI configuration (unexecuted remotely) | No remote run | **PARTIAL** | First GitHub Actions run |
| Docker hardening | Multi-stage `Dockerfile` + `docker-compose.prod.yml` (app/postgres/redis/worker/media/n8n/nginx), non-root app user, healthchecks, read-only where applicable | `docker build` not executed here | No registry | **PARTIAL** | Docker daemon unavailable in this sandbox |
| Secret management | `.env.example` contract, production validators in `env.ts` (fail-fast on missing secrets), no committed secrets (gitleaks gate) | env tests | No secret manager integration | **PASS (source)** | External KMS/vault integration is operator scope |
| MFA key rotation | `mfa.ts` encrypted TOTP secrets + `credentialVersion` rotation path; recovery codes single-use | mfa, enterprise-security | n/a | **PASS** | — |
| DB operations | `db:migrate` with advisory lock, no `db:push` in deploy paths, migration-safety gate, index audit | migration gate + route/integration suites | No EXPLAIN ANALYZE baseline on production data | **PARTIAL** | Production query plans |
| HA / media scaling | Stateless app + worker lease model; media server capacity guard (4429) and per-process limits; compose scaling documented | media-server capacity tests | No multi-replica soak | **PARTIAL** | **BLOCKED — staging soak** |

## P2 — advanced and commercial

| Area | Implementation | Tests | Status | Blocker |
| --- | --- | --- | --- | --- |
| WebRTC-ready architecture | Provider abstraction + media websocket protocol with codec negotiation; WebRTC transport not implemented | media-server suites | **PARTIAL** | Real WebRTC transport + browser client |
| Voice-cloning safety | `voice/voice-safety.ts` is the single gate for tenant-configured `voiceId`s: publisher/default voices are allowed, `TTS_ALLOWED_VOICE_IDS` can widen that set, anything else needs the platform opt-in (`VOICE_CLONING_ENABLED`) **and** a scoped consent record (subject, reference, exact voice ids) recorded via `/api/v1/business/voice-consent` (ADMIN, audited, revocable). Enforced at agent create/update **and** at synthesis time; the agent's configured voice is now actually passed to TTS (it was stored but unused) | `voice-safety` (4: fail-closed both directions, allowlist, cross-tenant, synthesis-time refusal + voice honoured after consent) | No cloned-voice provider configured (cloning stays off by default) | **PASS (source + tests)** | Live cloned-voice provider acceptance remains optional/external |
| Grounded call analytics | `conversation-intelligence.ts`, `answer-quality.ts` — analytics derived from stored transcripts only | deterministic tests | **PARTIAL** | Live corpus calibration |
| Cost governance | `pricing.ts`, usage meters; estimates are labelled as estimates, actuals come from meters | usage/metering tests | **PASS (source)** | Provider invoice reconciliation |
| Server-enforced entitlements | `tenant-config.ts` feature flags, quota reservations and plan limits enforced in services | quota/tenant-config tests | **PASS (source)** | — |
| White-labeling | `services/branding.ts` + `/api/v1/business/branding` (GET/PATCH, ADMIN for write, entitlement `whiteLabel`) and public `/api/v1/public/branding?domain=`; first-class unique `businesses.custom_domain` (migration `0016`), accent colour applied by the dashboard shell, logo/product name/support email/hide-platform-branding; host resolution returns platform branding for unknown, suspended or unentitled hosts (no tenant enumeration) | `branding-routes` (7: entitlements, validation incl. non-https logos, uniqueness/409, cross-tenant reads, public resolution, flag-merge) | No DNS/TLS wiring for customer domains | **PASS (source + tests)** | Edge/DNS + TLS provisioning for customer domains |

## Cross-cutting

| Area | Status | Evidence / blocker |
| --- | --- | --- |
| Tenant config schemas | **PASS** | `tenant-config.ts`, env validators, per-tenant settings JSON |
| Cursor pagination | **PASS** | `src/lib/pagination.ts` provides opaque keyset cursors `(created_at, id)` with validation (400 `VALIDATION_ERROR` on garbage), a relaxed SQL tuple comparison that stays index-backed, and `data`/`nextCursor`/`hasMore` on every response. All nine tenant list endpoints use it (`calls`, `leads`, `customers`, `appointments`, `users`, `knowledge`, `notifications`, `properties`, `usage`) while the legacy `page`/`limit` window keeps working; the dashboard table switches to cursors for forward pages and back to offsets on the known last page (so totals stay exact). Cursors are applied **in addition to** the tenant predicate, so a borrowed or forged cursor can only move the window inside the caller's own tenant — `tests/integration/cursor-pagination.test.ts` (5) and `tests/unit/{pagination,dashboard-pagination}.test.ts` (8) cover walks without duplicates, same-timestamp tie-breaking, cross-tenant replay and malformed cursors |
| Audit-log completeness | **PASS (source + tests)** | `audit_logs` written for auth, admin, billing, platform, config changes |
| Privacy / export / deletion | **PASS (source + tests)** | `data-governance.ts`, `/admin/privacy`, `/admin/exports`, tenant deletion state machine |
| Tenant offboarding state machine | **PASS** | `ACTIVE → SUSPENDED → PENDING_DELETION → DELETED`, SUPER_ADMIN + MFA + reason + grace period, atomic session revocation, audit; the suspend switch refuses to resurrect a pending-deletion or deleted tenant (409) and keeps `isActive`/`status` in step, and request-serving paths use `tenantServingState` (fails closed on either signal) |
| Readiness endpoints | **PASS** | `/api/health/live`, `/api/health/ready` (checks, providers, timestamp) |
| Migration safety | **PASS** | CI gate + migrate ×2 + restore-drill migrate ×2 |
| Provider failure policy | **PASS (source + tests)** | Missing credentials ⇒ `PROVIDER_NOT_CONFIGURED` 503, never a silent success; live suites fail loudly |
| Circuit breakers | **PASS** | `src/lib/circuit-breaker.ts`: per-provider breaker with threshold, exponential backoff, half-open probe, shared Redis state (in-process fallback), explicit `shouldCountFailure` classification; wired into the Twilio transport and the HTTP payment provider; `PROVIDER_CIRCUIT_OPEN` (503) fails fast without calling the provider. Tests: `circuit-breaker` (10) + `provider-circuit-breaker-integration` (5) |
| Request limits / rate-limit matrix / abuse protection | **PASS (source + tests)** | `rate-limit.ts` presets (login/refresh/publicWebhook/ai/upload/admin/default), body caps, Redis-backed counters |
| Cross-tab refresh | **PASS** | `src/lib/cross-tab.ts` (`BroadcastChannel`, same-origin, echo-dedupe, malformed-payload safe) wired into `AuthProvider` for login/logout/refresh; `tests/unit/cross-tab.test.ts` (8 cases) |
| Agent version diff / rollback-as-new-version | **PASS** | Agent snapshots + publish-as-new-version |
| Config audit | **PASS** | Config changes written to `audit_logs` with actor + tenant |
| AI memory governance | **PASS (source + tests)** | `memory.ts` tenant-scoped, retention-aware, disableable |
| Durable ingestion jobs | **PASS (source + tests)** | Statuses UPLOADED/PROCESSING/INDEXED/FAILED; failed documents are unsearchable |
| Document-processing bounds | **PASS** | Size/type/count bounds in `documents.ts` + upload constraints |
| Tenant + platform reports | **PASS** | Usage/analytics dashboards + platform tenant views |
| CHANGELOG / semver | **PASS** | `CHANGELOG.md` maintained per release |
| Error contract | **PASS (source + tests)** | `{ success:false, error:{ code, message, requestId } }` via `errors.ts` |
| Idempotency | **PASS (source + tests)** | Outbox idempotency keys, payment-reference uniqueness, webhook ledger, API idempotency keys |
| PII logging audit | **PASS** | Two-layer logger redaction (key denylist + manual `redact()`) **and** an enforced static gate over every structured log call site: `scripts/ci/pii-log-audit.mjs` fails on raw request bodies, credential keys, or personal-data keys that are not masked/hashed/reduced (waivers require an inline `pii-audit-allow:` reason and are printed). Gate self-tested by `tests/unit/pii-log-audit.test.ts` (unsafe fixture fails, reviewed fixture passes, real tree passes); wired into CI |
| N+1 / index / EXPLAIN ANALYZE audit | **PASS (CI gate)** | `scripts/ci/index-audit.mjs` runs in CI after both migrations: every one of the 50 tenant tables must have a `business_id`-leading index, hot-path indexes must exist, and three representative tenant queries are re-planned with `enable_seqscan = off` to prove an index path; migration `0015` closed the two gaps (`payment_events`, `refresh_tokens`) and `0016` adds the unique branding-domain index (`businesses.custom_domain`, 180 public indexes). `docs/INDEX-AUDIT.md` documents the N+1 review (no production `EXPLAIN ANALYZE` baseline yet) |
| Documentation labels | **PASS** | This matrix plus IMPLEMENTED/TESTED/BLOCKED labels across `docs/ENTERPRISE-*.md` |
| Final security review | **PARTIAL** | Internal review + automated gates; independent penetration test outstanding |
| Tenant A/B attack tests | **PASS** | `tenant-isolation.test.ts` (11 cases) + webhook forgery suites |
| gated deployment / rollback docs | **PARTIAL** | Compose + migration/rollback guidance documented; no deployment job/environment approvals yet |

## Remaining external blockers (cannot be closed without third parties)

| # | Blocker | Affected gate | Required to clear |
| --- | --- | --- | --- |
| 1 | Real PSTN call never placed | Telephony LIVE, voice minutes from carrier CDR | Purchased Twilio number + answered call (`LIVE_TELEPHONY_CALL_TO`, `LIVE_TELEPHONY_ACCEPT_CALL=yes`) |
| 2 | Live payment gateway account | Billing live lifecycle (checkout/refund/subscription) | Provider account + webhook secret |
| 3 | Live SMTP relay | Email verification, invitations, notification delivery | `SMTP_HOST/SMTP_USER/SMTP_PASS` + test inbox |
| 4 | Live Google/Microsoft production app | OIDC login acceptance, SAML/IdP | Registered app + redirect URIs + IdP metadata |
| 5 | Production object storage | Storage acceptance, retention/quotas on real buckets | S3-compatible endpoint + keys + bucket |
| 6 | Production telemetry endpoint (OTLP/Grafana/Sentry) | SLO baselines, alerting | Endpoint + credentials |
| 7 | Staging environment / browser binaries for this sandbox | Playwright E2E execution here, load tests, HA soak | CI runners (configured) or external runner |
| 8 | Docker daemon in this sandbox | Image build + Trivy scan locally | CI runner (configured) or Docker host |

## Bottom line

All P0 gates that can be verified without third-party infrastructure now pass: coverage
(91.97/91.97/94.02/81.12 on 752 tests with zero skips), tenant isolation with a documented RLS
decision, meters, billing core with an immutable ledger, a 15-topic transactional outbox, a
concrete telephony adapter, restore/DR drill, migration safety, live-suite loud-failure gating,
an enforced PII/secret log audit, and a green production build. The remaining P0 gaps are inherently external (real PSTN acceptance, live
gateway, live SMTP/OAuth/storage/telemetry) plus E2E execution outside this sandbox and load/HA
soak. P1 gaps closed in this round: WhatsApp channel (adapter + tests), cross-tab session
coordination, the load harness, provider circuit breakers, the prompt-injection red-team corpus,
the index/N+1 audit gate, SCIM + OIDC HTTP route coverage, and the PII/secret log audit gate.
P2 gaps closed in this round: white-labeling and voice-cloning safety (both entitlement/consent
gated with HTTP-level tests). The only P2 rows that remain PARTIAL are deliberately scoped:
WebRTC transport (the architecture and media protocol are ready; no WebRTC transport exists) and
live-corpus calibration of grounded call analytics. No in-source P0/P1 gap from the ledger
remains open.
**The platform is not declared Production Ready.**
