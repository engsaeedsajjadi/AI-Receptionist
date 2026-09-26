ALTER TABLE "call_messages" ADD COLUMN "event_id" varchar(255);--> statement-breakpoint
ALTER TABLE "call_messages" ADD COLUMN "seq" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "call_messages_call_event_idx" ON "call_messages" USING btree ("call_id","event_id");