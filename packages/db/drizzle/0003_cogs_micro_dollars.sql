-- Rename coverage_run's cost from float cents to exact integer micro-USD (Invariant 6). Backfill-safe:
-- add the bigint column with a default, convert existing rows (1 cent = 10_000 micros), drop the old
-- float column, then drop the temporary default. coverage_run has no append-only trigger (0002 guards
-- only snapshot/claim/delta/dossier_section/battlecard_section), so the UPDATE is permitted.
ALTER TABLE "coverage_run" ADD COLUMN "llm_cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "coverage_run" SET "llm_cost_micros" = round("llm_cost_cents"::numeric * 10000)::bigint;--> statement-breakpoint
ALTER TABLE "coverage_run" DROP COLUMN "llm_cost_cents";--> statement-breakpoint
ALTER TABLE "coverage_run" ALTER COLUMN "llm_cost_micros" DROP DEFAULT;
