-- M2 OKF bundle delivery. Append-only record of each git-push attempt: `published` shipped a commit,
-- `failed` errored (publish I/O or a refused bundle). `manifest` (path -> sha256) is the baseline the
-- next run diffs against. Append-only in depth like the history tables (0002): the reject-mutation
-- trigger blocks any UPDATE/DELETE against raw SQL, not just the app layer.

CREATE TYPE "bundle_delivery_status" AS ENUM('published', 'failed');--> statement-breakpoint

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
);--> statement-breakpoint

ALTER TABLE "okf_delivery" ADD CONSTRAINT "okf_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "okf_delivery_workspace_status_idx" ON "okf_delivery" USING btree ("workspace_id","status");--> statement-breakpoint

-- Append-only in depth: reuse flank_reject_mutation() (defined in 0002) to block UPDATE and DELETE.
CREATE TRIGGER okf_delivery_append_only BEFORE UPDATE OR DELETE ON "okf_delivery" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();
