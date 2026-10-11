CREATE TABLE "target_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_id" bigint,
	"name" text NOT NULL,
	"spec_url" text NOT NULL,
	"target" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"test_run_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "target_requests" ADD CONSTRAINT "target_requests_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_requests" ADD CONSTRAINT "target_requests_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "target_requests_status_idx" ON "target_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "target_requests_name_idx" ON "target_requests" USING btree ("name");