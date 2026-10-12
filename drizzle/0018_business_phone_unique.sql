-- SAFE: additive index only; no destructive statements.
-- One phone number, one tenant. Inbound calls resolve a tenant by the dialled
-- number, so two tenants claiming the same number would make call routing
-- ambiguous (and, before the resolver guard, silently misroute calls).
-- Partial: tenants without a configured number are unaffected.
-- If this migration fails on real data, duplicates already exist and must be
-- resolved by hand — the deploy is meant to stop, not to guess.
CREATE UNIQUE INDEX "businesses_phone_idx" ON "businesses" USING btree ("phone") WHERE "businesses"."phone" is not null;