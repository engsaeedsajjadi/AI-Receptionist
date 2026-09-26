ALTER TABLE "webhook_events" ALTER COLUMN "status" SET DEFAULT 'RECEIVED';--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "lease_token" varchar(64);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_status_lease_idx" ON "webhook_events" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "webhook_events_created_idx" ON "webhook_events" USING btree ("created_at");--> statement-breakpoint
-- Pre-inbox rows used 'processed' as a terminal marker; fold them into the
-- new terminal state so redeliveries of legacy keys collapse as duplicates.
UPDATE "webhook_events" SET "status" = 'COMPLETED', "updated_at" = now() WHERE "status" = 'processed';