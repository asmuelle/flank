-- Append-only enforcement at the DB tier (Invariants 3 & 5). Triggers are used rather than
-- REVOKE because REVOKE does not restrict the table owner/superuser that migrations and the app
-- role connect as, whereas row-level triggers fire for every role. TRUNCATE is unaffected (it
-- fires no row-level UPDATE/DELETE triggers), so test teardown still works.

CREATE OR REPLACE FUNCTION flank_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only violation: % on % is not permitted (Invariant 5)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Fully immutable history tables: no UPDATE, no DELETE, ever.
CREATE TRIGGER snapshot_append_only BEFORE UPDATE OR DELETE ON "snapshot" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();--> statement-breakpoint
CREATE TRIGGER claim_append_only BEFORE UPDATE OR DELETE ON "claim" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();--> statement-breakpoint
CREATE TRIGGER dossier_section_append_only BEFORE UPDATE OR DELETE ON "dossier_section" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();--> statement-breakpoint
CREATE TRIGGER battlecard_section_append_only BEFORE UPDATE OR DELETE ON "battlecard_section" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();--> statement-breakpoint

-- Delta is append-only except for state advancement; this guard mirrors ALLOWED_DELTA_TRANSITIONS
-- and assertDeltaTransition in @flank/core so even raw SQL cannot bypass the pricing firewall.
CREATE OR REPLACE FUNCTION flank_guard_delta_update() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
     OR NEW."from_snapshot_id" IS DISTINCT FROM OLD."from_snapshot_id"
     OR NEW."to_snapshot_id" IS DISTINCT FROM OLD."to_snapshot_id"
     OR NEW."changed_spans" IS DISTINCT FROM OLD."changed_spans"
     OR NEW."triage_class" IS DISTINCT FROM OLD."triage_class"
     OR NEW."materiality" IS DISTINCT FROM OLD."materiality"
     OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'delta %: only state and confirmed_by_snapshot_id are mutable (Invariant 5)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (
    (OLD."state" = 'pending' AND NEW."state" IN ('confirmed', 'dismissed', 'published'))
    OR (OLD."state" = 'confirmed' AND NEW."state" = 'published')
  ) THEN
    RAISE EXCEPTION 'delta %: illegal transition % -> % (Invariant 5)', OLD."id", OLD."state", NEW."state"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."triage_class" = 'pricing_change' AND OLD."state" = 'pending' AND NEW."state" = 'published' THEN
    RAISE EXCEPTION 'delta %: pricing_change cannot go pending -> published; confirmation required (Invariant 3)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."state" = 'confirmed' AND NEW."confirmed_by_snapshot_id" IS NULL THEN
    RAISE EXCEPTION 'delta %: -> confirmed requires confirmed_by_snapshot_id (Invariant 3)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER delta_no_delete BEFORE DELETE ON "delta" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();--> statement-breakpoint
CREATE TRIGGER delta_guard_update BEFORE UPDATE ON "delta" FOR EACH ROW EXECUTE FUNCTION flank_guard_delta_update();
