CREATE TABLE "quota_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"meter" varchar(40) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"consumed" numeric(24, 4) DEFAULT '0' NOT NULL,
	"reserved" numeric(24, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_overrides" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"amounts" jsonb NOT NULL,
	"settled_amounts" jsonb,
	"windows" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "quota_buckets" ADD CONSTRAINT "quota_buckets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_overrides" ADD CONSTRAINT "quota_overrides_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_buckets_meter_window" ON "quota_buckets" USING btree ("business_id","meter","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_reservations_tenant_key" ON "quota_reservations" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "quota_reservations_pending" ON "quota_reservations" USING btree ("business_id","status","created_at");--> statement-breakpoint
ALTER TABLE "quota_buckets" ADD CONSTRAINT "quota_buckets_nonnegative" CHECK ("consumed" >= 0 AND "reserved" >= 0);
--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservation_status" CHECK ("status" IN ('reserved','settled','released'));
--> statement-breakpoint
INSERT INTO quota_buckets (business_id, meter, window_start, consumed, reserved)
SELECT business_id, type, date_trunc('month', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', sum(quantity), 0
FROM usage_records WHERE type IN ('calls','voice_minutes','stt_minutes','tts_characters','llm_input_tokens','llm_output_tokens','embedding_tokens')
GROUP BY business_id, type, date_trunc('month', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
ON CONFLICT (business_id, meter, window_start) DO NOTHING;
