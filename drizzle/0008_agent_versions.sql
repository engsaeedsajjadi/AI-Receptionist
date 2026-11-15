CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credential_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_versions_tenant_idx" ON "agent_versions" USING btree ("business_id","agent_id","created_at");
--> statement-breakpoint
ALTER TABLE identity_tokens ADD CONSTRAINT identity_tokens_user_tenant_fk FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE agent_versions ADD CONSTRAINT agent_versions_agent_tenant_fk FOREIGN KEY (business_id, agent_id) REFERENCES agents(business_id, id) DEFERRABLE INITIALLY DEFERRED;
