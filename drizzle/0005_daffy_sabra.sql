ALTER TABLE "api_calls" ADD COLUMN "identity" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN "caller" text;