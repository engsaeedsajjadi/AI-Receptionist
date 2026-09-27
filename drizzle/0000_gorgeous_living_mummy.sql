CREATE TYPE "public"."appointment_status" AS ENUM('REQUESTED', 'SCHEDULED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."call_message_role" AS ENUM('CUSTOMER', 'AGENT', 'SYSTEM', 'TOOL');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('RINGING', 'CONNECTED', 'IN_PROGRESS', 'ANSWERED', 'TRANSFER_REQUESTED', 'TRANSFERRING', 'TRANSFERRED', 'TRANSFER_FAILED', 'COMPLETED', 'MISSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('NEW', 'CONTACTED', 'QUALIFIED', 'VISIT_REQUESTED', 'VISIT_SCHEDULED', 'NEGOTIATION', 'WON', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."lead_type" AS ENUM('BUY', 'RENT', 'SELL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'MANAGER', 'AGENT');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"voice_provider" varchar(100) DEFAULT 'mock' NOT NULL,
	"voice_id" varchar(100) DEFAULT 'fa-default' NOT NULL,
	"language" varchar(20) DEFAULT 'fa-IR' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid,
	"customer_id" uuid,
	"assigned_user_id" uuid,
	"title" varchar(255),
	"scheduled_at" timestamp with time zone,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"status" "appointment_status" DEFAULT 'REQUESTED' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"actor_type" varchar(30) NOT NULL,
	"actor_id" varchar(255),
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" varchar(255),
	"request_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"industry" varchar(100) DEFAULT 'real_estate' NOT NULL,
	"phone" varchar(30),
	"address" text,
	"timezone" varchar(50) DEFAULT 'Asia/Tehran' NOT NULL,
	"language" varchar(10) DEFAULT 'fa' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{"recording_enabled":true,"transcription_enabled":true,"retention_days":90,"disclosure_message":"این تماس ممکن است برای بهبود خدمات ضبط شود."}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"role" "call_message_role" NOT NULL,
	"content" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"agent_id" uuid,
	"external_call_id" varchar(255),
	"direction" "call_direction" DEFAULT 'INBOUND' NOT NULL,
	"phone_number" varchar(30) NOT NULL,
	"status" "call_status" DEFAULT 'RINGING' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"recording_url" text,
	"transcript" text,
	"summary" text,
	"transfer_to" varchar(30),
	"transfer_requested_at" timestamp with time zone,
	"transfer_completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(255) DEFAULT '' NOT NULL,
	"phone" varchar(30) NOT NULL,
	"email" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"token_count" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"source_type" varchar(50) DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"file_name" varchar(255),
	"mime_type" varchar(100),
	"file_size" integer,
	"storage_key" text,
	"status" varchar(20) DEFAULT 'indexed' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"user_id" uuid,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid,
	"source" varchar(50) DEFAULT 'call' NOT NULL,
	"type" "lead_type" DEFAULT 'OTHER' NOT NULL,
	"status" "lead_status" DEFAULT 'NEW' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"budget_min" numeric,
	"budget_max" numeric,
	"location" text,
	"min_area" numeric,
	"max_area" numeric,
	"bedrooms" integer,
	"timeframe" varchar(50),
	"requested_visit" boolean DEFAULT false NOT NULL,
	"summary" text,
	"notes" text,
	"assigned_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"type" varchar(50) NOT NULL,
	"channel" varchar(20) DEFAULT 'internal' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" varchar(255),
	"recipient" varchar(255),
	"error_message" text,
	"sent_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"code" varchar(50),
	"title" varchar(255) NOT NULL,
	"description" text,
	"transaction_type" varchar(20) NOT NULL,
	"property_type" varchar(30),
	"city" varchar(100),
	"neighborhood" varchar(100),
	"address" text,
	"location" text NOT NULL,
	"price" numeric NOT NULL,
	"price_currency" varchar(10) DEFAULT 'TOMAN' NOT NULL,
	"area" numeric NOT NULL,
	"bedrooms" integer DEFAULT 0 NOT NULL,
	"bathrooms" integer,
	"year_built" integer,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"jti" varchar(64),
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(50),
	"rotated_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"quantity" numeric NOT NULL,
	"unit" varchar(30) NOT NULL,
	"provider" varchar(50),
	"estimated_cost" numeric,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"idempotency_key" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(30),
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'AGENT' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"scope" varchar(100) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'processed' NOT NULL,
	"payload_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_messages" ADD CONSTRAINT "call_messages_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_business_idx" ON "agents" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "agents_business_active_idx" ON "agents" USING btree ("business_id","is_active");--> statement-breakpoint
CREATE INDEX "appointments_business_scheduled_idx" ON "appointments" USING btree ("business_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "appointments_business_status_idx" ON "appointments" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "appointments_business_assignee_idx" ON "appointments" USING btree ("business_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_business_created_idx" ON "audit_logs" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_business_action_idx" ON "audit_logs" USING btree ("business_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_slug_idx" ON "businesses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "call_messages_call_time_idx" ON "call_messages" USING btree ("call_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_business_external_idx" ON "calls" USING btree ("business_id","external_call_id");--> statement-breakpoint
CREATE INDEX "calls_business_status_idx" ON "calls" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "calls_business_created_idx" ON "calls" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_business_phone_idx" ON "calls" USING btree ("business_id","phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_business_phone_idx" ON "customers" USING btree ("business_id","phone");--> statement-breakpoint
CREATE INDEX "customers_business_created_idx" ON "customers" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_business_idx" ON "knowledge_chunks" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_idx" ON "knowledge_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "knowledge_documents_business_status_idx" ON "knowledge_documents" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_documents_business_created_idx" ON "knowledge_documents" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_notes_lead_created_idx" ON "lead_notes" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_notes_business_idx" ON "lead_notes" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "leads_business_status_idx" ON "leads" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "leads_business_created_idx" ON "leads" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_business_customer_idx" ON "leads" USING btree ("business_id","customer_id");--> statement-breakpoint
CREATE INDEX "leads_business_assignee_idx" ON "leads" USING btree ("business_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "notifications_business_created_idx" ON "notifications" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_business_user_idx" ON "notifications" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_business_idem_idx" ON "notifications" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "properties_business_available_idx" ON "properties" USING btree ("business_id","is_available");--> statement-breakpoint
CREATE INDEX "properties_business_txn_idx" ON "properties" USING btree ("business_id","transaction_type");--> statement-breakpoint
CREATE INDEX "properties_business_city_idx" ON "properties" USING btree ("business_id","city");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_business_code_idx" ON "properties" USING btree ("business_id","code");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_jti_idx" ON "refresh_tokens" USING btree ("jti");--> statement-breakpoint
CREATE INDEX "usage_business_type_idx" ON "usage_records" USING btree ("business_id","type");--> statement-breakpoint
CREATE INDEX "usage_business_created_idx" ON "usage_records" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_business_idem_idx" ON "usage_records" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_business_idx" ON "users" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "users_business_role_idx" ON "users" USING btree ("business_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_scope_key_idx" ON "webhook_events" USING btree ("scope","idempotency_key");