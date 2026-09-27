ALTER TABLE "agents" ALTER COLUMN "voice_provider" SET DEFAULT 'generic';--> statement-breakpoint
UPDATE "agents" SET "voice_provider" = 'generic' WHERE "voice_provider" = 'mock';
