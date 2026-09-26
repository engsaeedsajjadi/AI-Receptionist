ALTER TABLE "businesses" ADD COLUMN "voice_number" varchar(30);--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_voice_number_idx" ON "businesses" USING btree ("voice_number");