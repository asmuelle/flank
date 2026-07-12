-- M2 OKF bundle delivery. Append-only record of each git-push attempt: `published` shipped a
-- commit, while `failed` records a refused bundle or publish I/O error. `manifest` is the next
-- run's path-to-sha256 baseline.
CREATE TYPE "public"."bundle_delivery_status" AS ENUM('published', 'failed');--> statement-breakpoint
CREATE TABLE "okf_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" "bundle_delivery_status" NOT NULL,
	"commit_sha" text,
	"branch_ref" text,
	"pull_request_url" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"files_added" integer DEFAULT 0 NOT NULL,
	"files_modified" integer DEFAULT 0 NOT NULL,
	"files_removed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "okf_delivery" ADD CONSTRAINT "okf_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "okf_delivery_workspace_status_idx" ON "okf_delivery" USING btree ("workspace_id","status");--> statement-breakpoint

-- Reuse the database-level append-only guard introduced in 0002 (Invariant 5).
CREATE TRIGGER okf_delivery_append_only BEFORE UPDATE OR DELETE ON "okf_delivery" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();
