CREATE TYPE "public"."business_lifecycle" AS ENUM('ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('DRAFT', 'PROCESSING', 'ACTIVE', 'ARCHIVED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."knowledge_visibility" AS ENUM('TENANT', 'ROLE', 'AGENT', 'CATEGORY', 'PRIVATE');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'delivered', 'dead');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."payment_transaction_kind" AS ENUM('CHARGE', 'REFUND', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('REQUESTED', 'SUCCEEDED', 'FAILED', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"prefix" varchar(24) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"service_account_id" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(100),
	"rotated_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reason" text NOT NULL,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"requested_by" uuid,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"storage_key" text,
	"bytes" numeric(24, 0),
	"row_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'AGENT' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"resend_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"topic" varchar(80) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_id" uuid,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid,
	"provider" varchar(50) NOT NULL,
	"plan" varchar(20) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"provider_reference" varchar(255),
	"checkout_url" text,
	"expires_at" timestamp with time zone,
	"failure_code" varchar(100),
	"failure_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"business_id" uuid,
	"payload_hash" varchar(64) NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_customer_id" varchar(255),
	"mode" varchar(20) DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"attempt_id" uuid,
	"invoice_id" uuid,
	"kind" "payment_transaction_kind" NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_transaction_id" varchar(255) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"plan" varchar(20),
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"actor_type" varchar(30) DEFAULT 'provider' NOT NULL,
	"actor_id" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"provider" varchar(50) NOT NULL,
	"scope" varchar(100) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"payload_hash" varchar(64),
	"status" varchar(20) DEFAULT 'processed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_refund_id" varchar(255),
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "refund_status" DEFAULT 'REQUESTED' NOT NULL,
	"reason" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "retrieval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"query" text NOT NULL,
	"query_hash" varchar(64) NOT NULL,
	"strategy" varchar(30) DEFAULT 'hybrid' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"used_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reranker" varchar(50),
	"rerank_ms" integer,
	"retrieval_ms" integer DEFAULT 0 NOT NULL,
	"agent_id" uuid,
	"call_id" uuid,
	"outcome" varchar(20) DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission" varchar(60) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"description" varchar(255),
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(255),
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"key" text NOT NULL,
	"bytes" numeric(24, 0) NOT NULL,
	"content_type" varchar(150),
	"category" varchar(40) DEFAULT 'other' NOT NULL,
	"source_type" varchar(40),
	"source_id" uuid,
	"checksum" varchar(64),
	"retained_until" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"from_plan" varchar(20),
	"to_plan" varchar(20),
	"provider" varchar(50),
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" varchar(30) DEFAULT 'system' NOT NULL,
	"actor_id" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" varchar(80) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" varchar(255),
	"secret_hash" varchar(64) NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- SAFE: replaced by a business-scoped unique index added below.
DROP INDEX "webhook_events_scope_key_idx";--> statement-breakpoint
-- Preflight (safe upgrade): legacy rows with no tenant identity cannot be
-- attributed to a tenant and only exist for deprecated global webhook scopes.
-- They are idempotency-ledger entries, not business data, so they are removed
-- rather than assigned a fabricated tenant.
DELETE FROM "webhook_events" WHERE "business_id" IS NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "business_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "status" "business_lifecycle" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "deletion_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "lifecycle" "knowledge_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "supersedes_document_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "visibility" "knowledge_visibility" DEFAULT 'TENANT' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "acl" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "language" varchar(10) DEFAULT 'fa' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "document_type" varchar(60);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "category" varchar(80);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "product" varchar(120);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "service" varchar(120);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "branch" varchar(120);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "department" varchar(120);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "effective_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider" varchar(50);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_subscription_id" varchar(255);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" varchar(10) DEFAULT 'fa' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_providers" ADD CONSTRAINT "payment_providers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_records" ADD CONSTRAINT "refund_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_records" ADD CONSTRAINT "refund_records_transaction_id_payment_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_records" ADD CONSTRAINT "refund_records_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_events" ADD CONSTRAINT "retrieval_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_events" ADD CONSTRAINT "retrieval_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_events" ADD CONSTRAINT "retrieval_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_notes_tenant_idx" ON "credit_notes" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "data_exports_tenant_idx" ON "data_exports" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_tenant_email_idx" ON "invitations" USING btree ("business_id","email");--> statement-breakpoint
CREATE INDEX "invitations_tenant_idx" ON "invitations" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_tenant_key_idx" ON "outbox_events" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_events_tenant_idx" ON "outbox_events" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_topic_idx" ON "outbox_events" USING btree ("business_id","topic","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_tenant_key_idx" ON "payment_attempts" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_ref_idx" ON "payment_attempts" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "payment_attempts_tenant_created_idx" ON "payment_attempts" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_idx" ON "payment_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_providers_tenant_provider_idx" ON "payment_providers" USING btree ("business_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_provider_txn_idx" ON "payment_transactions" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_tenant_created_idx" ON "payment_transactions" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_transactions_invoice_idx" ON "payment_transactions" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_scope_key_idx" ON "provider_events" USING btree ("provider","scope","event_id");--> statement-breakpoint
CREATE INDEX "provider_events_tenant_idx" ON "provider_events" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_records_provider_ref_idx" ON "refund_records" USING btree ("provider","provider_refund_id");--> statement-breakpoint
CREATE INDEX "refund_records_tenant_idx" ON "refund_records" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "retrieval_events_tenant_created_idx" ON "retrieval_events" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "retrieval_events_query_idx" ON "retrieval_events" USING btree ("business_id","query_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_unique_idx" ON "role_permissions" USING btree ("business_id","role_id","permission");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_tenant_name_idx" ON "service_accounts" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_objects_tenant_key_idx" ON "storage_objects" USING btree ("business_id","key");--> statement-breakpoint
CREATE INDEX "storage_objects_tenant_category_idx" ON "storage_objects" USING btree ("business_id","category");--> statement-breakpoint
CREATE INDEX "storage_objects_retention_idx" ON "storage_objects" USING btree ("retained_until");--> statement-breakpoint
CREATE INDEX "subscription_events_tenant_idx" ON "subscription_events" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "support_sessions_tenant_idx" ON "support_sessions" USING btree ("business_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_idx" ON "user_roles" USING btree ("business_id","user_id","role_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_tenant_key_idx" ON "webhook_deliveries" USING btree ("endpoint_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_idx" ON "webhook_deliveries" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_idx" ON "webhook_endpoints" USING btree ("business_id","is_active");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_tenant_id_idx" ON "agents" USING btree ("id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_tenant_id_idx" ON "calls" USING btree ("id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_tenant_id_idx" ON "knowledge_documents" USING btree ("id","business_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_version_idx" ON "knowledge_documents" USING btree ("business_id","title","version");--> statement-breakpoint
CREATE INDEX "knowledge_documents_lifecycle_idx" ON "knowledge_documents" USING btree ("business_id","lifecycle");--> statement-breakpoint
CREATE INDEX "knowledge_documents_supersedes_idx" ON "knowledge_documents" USING btree ("business_id","supersedes_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_tenant_id_idx" ON "leads" USING btree ("id","business_id");--> statement-breakpoint
CREATE INDEX "subscriptions_provider_sub_idx" ON "subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "webhook_events_tenant_idx" ON "webhook_events" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_scope_key_idx" ON "webhook_events" USING btree ("business_id","scope","idempotency_key");


-- Composite tenant foreign keys (added after the tenant-composite unique
-- indexes they reference; a dependent row can never point across tenants).
ALTER TABLE "call_messages" ADD CONSTRAINT "call_messages_call_tenant_fk" FOREIGN KEY ("call_id","business_id") REFERENCES "public"."calls"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_pipeline_tenant_fk" FOREIGN KEY ("pipeline_id","business_id") REFERENCES "public"."crm_pipelines"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_tenant_fk" FOREIGN KEY ("document_id","business_id") REFERENCES "public"."knowledge_documents"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_tenant_fk" FOREIGN KEY ("lead_id","business_id") REFERENCES "public"."leads"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
