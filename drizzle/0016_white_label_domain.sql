-- SAFE: additive column + unique index; no destructive statements.
-- White-labeling: a tenant's custom domain is a first-class, unique column so two
-- tenants can never resolve to the same host (the API pre-check is only a
-- friendlier error; this index is the guard). NULL is allowed many times, which is
-- exactly the "no custom domain" state.
ALTER TABLE "businesses" ADD COLUMN "custom_domain" varchar(253);--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_custom_domain_idx" ON "businesses" USING btree ("custom_domain");