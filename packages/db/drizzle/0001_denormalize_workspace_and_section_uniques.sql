-- Denormalize workspace_id onto the history tables (Invariant 8). Backfill-safe: add nullable,
-- populate from the existing source/competitor join, THEN enforce NOT NULL + FK. This ordering is
-- load-bearing once these tables hold data and the append-only guards (0002) make rows immutable.
ALTER TABLE "snapshot" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "snapshot" sn SET "workspace_id" = c."workspace_id" FROM "source" s JOIN "competitor" c ON s."competitor_id" = c."id" WHERE sn."source_id" = s."id";--> statement-breakpoint
ALTER TABLE "snapshot" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "delta" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "delta" d SET "workspace_id" = c."workspace_id" FROM "source" s JOIN "competitor" c ON s."competitor_id" = c."id" WHERE d."source_id" = s."id";--> statement-breakpoint
ALTER TABLE "delta" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "claim" cl SET "workspace_id" = c."workspace_id" FROM "delta" d JOIN "source" s ON d."source_id" = s."id" JOIN "competitor" c ON s."competitor_id" = c."id" WHERE cl."delta_id" = d."id";--> statement-breakpoint
ALTER TABLE "claim" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delta" ADD CONSTRAINT "delta_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshot_source_fetched_idx" ON "snapshot" USING btree ("source_id","fetched_at");--> statement-breakpoint
ALTER TABLE "battlecard_section" ADD CONSTRAINT "battlecard_section_competitor_kind_version_uq" UNIQUE("competitor_id","kind","version");--> statement-breakpoint
ALTER TABLE "dossier_section" ADD CONSTRAINT "dossier_section_competitor_kind_version_uq" UNIQUE("competitor_id","kind","version");
