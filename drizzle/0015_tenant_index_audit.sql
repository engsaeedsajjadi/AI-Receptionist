-- SAFE: additive indexes only; no destructive statements.
-- Index audit remediation: every tenant-scoped table must have an index whose
-- leading column is business_id so tenant filters never fall back to a sequential
-- scan as data grows. payment_events and refresh_tokens were the only tables
-- without one (see scripts/ci/index-audit.mjs).
CREATE INDEX IF NOT EXISTS "payment_events_tenant_created_idx" ON "payment_events" USING btree ("business_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_tenant_user_idx" ON "refresh_tokens" USING btree ("business_id","user_id");
