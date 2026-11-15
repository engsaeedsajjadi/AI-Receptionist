CREATE TABLE "crm_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"lead_id" uuid,
	"title" varchar(255) NOT NULL,
	"stage" varchar(100) NOT NULL,
	"value" numeric(20, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(10) DEFAULT 'TOMAN' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"stages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid,
	"assigned_user_id" uuid,
	"title" varchar(255) NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'OPEN' NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_pipeline_id_crm_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_opportunities_stage_idx" ON "crm_opportunities" USING btree ("business_id","pipeline_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_name_idx" ON "crm_pipelines" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_tenant_id_idx" ON "crm_pipelines" USING btree ("business_id","id");--> statement-breakpoint
CREATE INDEX "crm_tasks_due_idx" ON "crm_tasks" USING btree ("business_id","status","due_at");
--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_pipeline_id_tenant_fk" FOREIGN KEY ("business_id", "pipeline_id") REFERENCES "crm_pipelines" ("business_id", "id") DEFERRABLE INITIALLY DEFERRED;

--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_lead_id_tenant_fk" FOREIGN KEY ("business_id", "lead_id") REFERENCES "leads" ("business_id", "id") DEFERRABLE INITIALLY DEFERRED;

--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_lead_id_tenant_fk" FOREIGN KEY ("business_id", "lead_id") REFERENCES "leads" ("business_id", "id") DEFERRABLE INITIALLY DEFERRED;

--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_assigned_user_id_tenant_fk" FOREIGN KEY ("business_id", "assigned_user_id") REFERENCES "users" ("business_id", "id") DEFERRABLE INITIALLY DEFERRED;
