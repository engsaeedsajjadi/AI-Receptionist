# Security review — 2026-10-04

Status: release blocked pending the outstanding items below. This is an engineering review and automated-test record, not a penetration-test certificate.

## Addressed in this branch

- Refresh-token hashes cover the complete token; rotation/reuse revocation is serialized with user-row locks, and revocation commits before error responses.
- Access authorization checks active tenant, active user, credential state and session revocation; caller-supplied tenant headers cannot switch identity.
- MFA secrets use AES-256-GCM with user-specific associated data; TOTP steps cannot be reused. Recovery codes and identity links are single-use hashes. Password/MFA changes invalidate sessions.
- New passwords use native scrypt N=32768,r=8,p=3 with random 16-byte salts; old bcrypt remains compatible. Parameters are fixed/validated rather than accepted from arbitrary encoded input. Password changes/reset replace legacy hashes. This avoids silent UTF-8 truncation for new long Persian passwords.
- OIDC uses a maintained protocol client, PKCE, nonce, state, browser-bound cookies and explicit issuer/subject linking. Email coincidence is never sufficient to take over an account.
- Legacy role permissions remain constrained while new operator roles use explicit capabilities. Tenant admins cannot assign SUPER_ADMIN.
- Composite tenant foreign keys protect selected relationships even if an application predicate is missed. Request context rejects scope changes, caching includes tenant and configuration-content identity.
- Agent configuration fails closed; selected tools are filtered both when advertised and executed in the agent runtime. Knowledge/memory text remains untrusted quoted data, not authorization evidence.
- Production HMAC requires a signed timestamp, bounded body reading and a stable idempotency key. One previous secret can temporarily overlap rotation.
- New JSON parser bounds body bytes before parsing. Invalid reindex input no longer escalates into reindexing all documents.
- Operational metrics require a distinct bearer credential; no customer/tenant metric labels are exposed. Trace bodies do not contain prompts or transcripts.

## Dependency review

The original locked Next.js/Nodemailer/PostCSS/sharp dependency graph had high/critical advisories. Upgraded to patched versions and reran `npm audit --omit=dev --audit-level=high`: zero known production dependency vulnerabilities on this date. This does not establish container-image or application security. Run dependency and image scans continuously.

Primary references: https://github.com/vercel/next.js/releases/tag/v16.3.8 ; https://github.com/advisories/GHSA-p293-qw3h-jr36 ; https://github.com/nodemailer/nodemailer/releases ; https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ; https://www.rfc-editor.org/rfc/rfc6238 .

## Remaining risks / required evidence

- No PostgreSQL RLS rollout; table-by-table service/route review and complete relationship coverage still required. Webhook infrastructure ledger retains nullable tenant identity.
- SUPER_ADMIN tenant listing and state changes now use a dedicated MFA-gated control plane with live database privilege checks, row locks and transactional audit/session revocation. Own-tenant state changes are prohibited. Provisioning and broader platform operations remain incomplete. Suspension does not cancel already-running provider requests.
- Real Google/Microsoft/SMTP acceptance and OIDC negative cryptographic protocol tests remain required; unit tests alone are insufficient.
- Strict refresh replay revokes all sessions. Multi-tab refresh coordination beyond the current single-tab single-flight client still needs implementation/acceptance.
- Provider tool execution is not exactly once across crashes. Stable event keys and queue acknowledgement protect selected paths; complete transactional outbox/notification coverage remains outstanding.
- HMAC freshness does not by itself prevent all replay within its window. Tenant-specific provider credentials and complete replay/idempotency persistence require further review.
- RAG evidence and rolling memory are not guaranteed factual verification. Document ACLs, prompt-injection evaluation, provenance and retention controls need additional work.
- Coverage gate is below 80%; live voice, browser accessibility, recovery/restore and load tests remain release gates.
- MFA encryption-key rotation is an operational migration, not an automatic keyring; retain encrypted backups and the correct key securely.
