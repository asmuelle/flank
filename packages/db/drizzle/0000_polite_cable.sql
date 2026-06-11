CREATE TYPE "public"."alert_channel" AS ENUM('slack', 'email', 'crm');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('queued', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."battlecard_section_kind" AS ENUM('why_we_win', 'landmines', 'pricing_counter', 'objections');--> statement-breakpoint
CREATE TYPE "public"."delta_state" AS ENUM('pending', 'confirmed', 'dismissed', 'published');--> statement-breakpoint
CREATE TYPE "public"."legal_status" AS ENUM('open', 'licensed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('starter', 'growth', 'team');--> statement-breakpoint
CREATE TYPE "public"."dossier_section_kind" AS ENUM('overview', 'pricing', 'product', 'gtm', 'team');--> statement-breakpoint
CREATE TYPE "public"."source_adapter" AS ENUM('rss', 'json', 'html', 'firecrawl', 'zyte');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('pricing', 'changelog', 'docs', 'jobs', 'reviews', 'status', 'blog', 'appstore');--> statement-breakpoint
CREATE TYPE "public"."triage_class" AS ENUM('pricing_change', 'feature_launch', 'repositioning', 'leadership_hire', 'hiring_signal', 'noise');--> statement-breakpoint
CREATE TABLE "alert" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"delta_id" text NOT NULL,
	"channel" "alert_channel" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "alert_status" DEFAULT 'queued' NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "battlecard_section" (
	"id" text PRIMARY KEY NOT NULL,
	"competitor_id" text NOT NULL,
	"kind" "battlecard_section_kind" NOT NULL,
	"version" integer NOT NULL,
	"content_md" text NOT NULL,
	"claim_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim" (
	"id" text PRIMARY KEY NOT NULL,
	"delta_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"quote_text" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"source_url" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "competitor" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"primary_domain" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_run" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period" text NOT NULL,
	"sources_checked" integer NOT NULL,
	"fetch_failures" integer NOT NULL,
	"deltas_found" integer NOT NULL,
	"material_deltas" integer NOT NULL,
	"llm_calls" integer NOT NULL,
	"llm_cost_cents" real NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delta" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"from_snapshot_id" text,
	"to_snapshot_id" text NOT NULL,
	"changed_spans" jsonb NOT NULL,
	"triage_class" "triage_class" NOT NULL,
	"materiality" integer NOT NULL,
	"rationale" text NOT NULL,
	"state" "delta_state" DEFAULT 'pending' NOT NULL,
	"confirmed_by_snapshot_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dossier_section" (
	"id" text PRIMARY KEY NOT NULL,
	"competitor_id" text NOT NULL,
	"kind" "dossier_section_kind" NOT NULL,
	"version" integer NOT NULL,
	"content_md" text NOT NULL,
	"claim_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"batch_id" text,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"s3_key" text,
	"normalized_text" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"vantage" text,
	"http_status" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text PRIMARY KEY NOT NULL,
	"competitor_id" text NOT NULL,
	"type" "source_type" NOT NULL,
	"url_or_endpoint" text NOT NULL,
	"adapter" "source_adapter" NOT NULL,
	"cadence" text NOT NULL,
	"legal_status" "legal_status" DEFAULT 'open' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan_tier" "plan_tier" DEFAULT 'starter' NOT NULL,
	"competitor_limit" integer DEFAULT 5 NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_delta_id_delta_id_fk" FOREIGN KEY ("delta_id") REFERENCES "public"."delta"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battlecard_section" ADD CONSTRAINT "battlecard_section_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_delta_id_delta_id_fk" FOREIGN KEY ("delta_id") REFERENCES "public"."delta"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor" ADD CONSTRAINT "competitor_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_run" ADD CONSTRAINT "coverage_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delta" ADD CONSTRAINT "delta_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delta" ADD CONSTRAINT "delta_from_snapshot_id_snapshot_id_fk" FOREIGN KEY ("from_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delta" ADD CONSTRAINT "delta_to_snapshot_id_snapshot_id_fk" FOREIGN KEY ("to_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delta" ADD CONSTRAINT "delta_confirmed_by_snapshot_id_snapshot_id_fk" FOREIGN KEY ("confirmed_by_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_section" ADD CONSTRAINT "dossier_section_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE no action ON UPDATE no action;