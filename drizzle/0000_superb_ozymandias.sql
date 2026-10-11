CREATE TABLE "claim_diffs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tool_id" bigint NOT NULL,
	"from_version_id" bigint NOT NULL,
	"to_version_id" bigint NOT NULL,
	"claim_key" text NOT NULL,
	"change_type" text NOT NULL,
	"from_claim_id" bigint,
	"to_claim_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tool_version_id" bigint NOT NULL,
	"test_run_id" bigint NOT NULL,
	"claim_key" text NOT NULL,
	"statement" text NOT NULL,
	"endpoint" text NOT NULL,
	"kind" text NOT NULL,
	"param_name" text,
	"verdict" text NOT NULL,
	"source" text NOT NULL,
	"confidence" real NOT NULL,
	"divergence_type" text,
	"spec_says" text,
	"verified" boolean DEFAULT false NOT NULL,
	"evidence_trial_ids" bigint[] NOT NULL,
	"expectations" jsonb NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tool_version_id" bigint NOT NULL,
	"battery_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"llm_model" text,
	"llm_input_tokens" integer DEFAULT 0 NOT NULL,
	"llm_output_tokens" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tool_id" bigint NOT NULL,
	"version_label" text,
	"spec_url" text NOT NULL,
	"spec_blob" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'rest_api' NOT NULL,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"test_run_id" bigint NOT NULL,
	"endpoint" text NOT NULL,
	"mutation_type" text NOT NULL,
	"mutation_id" text NOT NULL,
	"param_name" text,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"signature" jsonb NOT NULL,
	"status_code" integer,
	"error_text" text,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_diffs" ADD CONSTRAINT "claim_diffs_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_diffs" ADD CONSTRAINT "claim_diffs_from_version_id_tool_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."tool_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_diffs" ADD CONSTRAINT "claim_diffs_to_version_id_tool_versions_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."tool_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_tool_version_id_tool_versions_id_fk" FOREIGN KEY ("tool_version_id") REFERENCES "public"."tool_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_tool_version_id_tool_versions_id_fk" FOREIGN KEY ("tool_version_id") REFERENCES "public"."tool_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claims_version_idx" ON "claims" USING btree ("tool_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_run_key_idx" ON "claims" USING btree ("test_run_id","claim_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_versions_tool_hash_idx" ON "tool_versions" USING btree ("tool_id","spec_hash");--> statement-breakpoint
CREATE INDEX "trials_run_idx" ON "trials" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "trials_hash_idx" ON "trials" USING btree ("input_hash");