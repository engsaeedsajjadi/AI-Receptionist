# Manual invoice subscriptions

Implemented scope: FREE fallback plus configurable STARTER, BUSINESS and ENTERPRISE plan invoices, operator reconciliation, monthly subscription periods, renewal requests and cancellation. **This does not yet enforce usage quotas, collect money automatically, generate tax-compliant jurisdiction-specific invoices or process refunds.** Existing usage dashboards continue to show provider usage and estimated costs separately from subscription fees. Existing tenant functionality is preserved.

## Operator configuration

Set `BILLING_CATALOG_JSON` to a JSON object containing `issuer`, `paymentInstructions` and `plans`. Each plan contains `plan` (STARTER/BUSINESS/ENTERPRISE), a positive integer `amountMinor` and `currency` (USD/EUR/GBP/IRR). USD/EUR/GBP amounts are cents/pence; IRR amounts are whole rials. Example **test configuration only**, not a recommended or deployed price:

```json
{"issuer":"Test Company — replace with actual business details","paymentInstructions":"Replace with verified payment instructions","plans":[{"plan":"STARTER","amountMinor":1234,"currency":"USD"}]}
```

Leave the variable empty to disable paid invoice issuance. Undefined plans cannot be purchased. Production Compose forwards the variable. Set verified issuer details, actual contracted prices and payment instructions before offering invoices. Do not use test values in production. Configuration changes do not rewrite existing invoice snapshots. Local tax rules, invoice numbering requirements and retention policy need implementation/review before commercial rollout.

## Tenant workflow

Tenant administrators open `/dashboard/billing`, request a plan invoice and view/print it (browser Save as PDF). POST request keys prevent retry-created duplicate invoices. Open invoices can be voided. Tenant administrators cannot mark invoices paid or directly change their paid plan. Expired/missing subscriptions resolve to FREE immediately without waiting for cron. This plan state currently does **not** enforce consumption limits.

## Operator workflow

An active SUPER_ADMIN with MFA opens `/dashboard/platform-billing`. Independently verify receipt of the exact amount and currency in the actual bank account. Enter a globally unique payment reference, including bank/account prefix if needed, and attest reconciliation. The server records this operator assertion; it does not call a bank or transfer funds. A transaction locks the tenant and invoice, validates amount/currency/state, updates the subscription, records payment and creates an audit event. Retrying the same invoice/reference is idempotent. Reusing the reference for another invoice fails and rolls back subscription changes.

The first payment starts one calendar month at reconciliation time in UTC. End-of-month dates clamp to the next month's last day. Same-plan renewal extends from the existing end date; no automatic charge occurs. Switching plans while a paid period is active is rejected; no silent proration calculation is invented. Cancellation preserves the already-paid period and voids open invoices. Resume is required to request renewals again. Payment on void/paid-with-different-reference invoices is rejected. Refunds require a future explicit ledger workflow; do not edit paid invoices in place.

## API

- `GET /api/v1/billing`: effective plan, subscription, latest 100 tenant invoices and configured paid plans.
- `POST /api/v1/billing`: `{plan,idempotencyKey}` (UUID), returns invoice.
- `DELETE /api/v1/billing`: `{id}`, voids own open invoice.
- `PATCH /api/v1/billing`: `{cancelAtPeriodEnd:boolean}`.
- `GET /api/v1/platform/billing`: latest 100 open invoices for reconciliation (SUPER_ADMIN + MFA).
- `POST /api/v1/platform/billing`: `{id,businessId,amountMinor,currency,paymentReference}`.

All tenant billing endpoints require tenant-admin capability. Platform services independently check live database identity and MFA state. All billing tables have `business_id`; invoice access uses tenant predicates. Larger invoice archives/pagination, automated payment webhooks, quotas, tax/refund ledger and recurring collection remain release work.
