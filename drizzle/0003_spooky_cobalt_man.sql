CREATE TABLE "automation_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"event" varchar(50) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"recipient" varchar(255) NOT NULL,
	"title" varchar(255) DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"notification_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_dispatches" ADD CONSTRAINT "automation_dispatches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_dispatches" ADD CONSTRAINT "automation_dispatches_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_dispatches_business_created_idx" ON "automation_dispatches" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_dispatches_business_idem_idx" ON "automation_dispatches" USING btree ("business_id","idempotency_key");