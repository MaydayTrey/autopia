CREATE TABLE "api_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_id" bigint,
	"tool" text NOT NULL,
	"target" text,
	"ok" boolean NOT NULL,
	"ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"quota_per_day" integer DEFAULT 2000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_name_unique" UNIQUE("name"),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_calls_key_time_idx" ON "api_calls" USING btree ("key_id","created_at");