ALTER TABLE "claims" ADD COLUMN "verified_by" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "verified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "tier" text DEFAULT 'server' NOT NULL;