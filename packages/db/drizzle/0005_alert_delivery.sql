-- M3 alert delivery. Adds per-workspace delivery destinations and reshapes the (writerless, empty)
-- 0000 `alert` stub into a deduplicated delivery log: one row per (delta, channel), status advancing
-- on a strict machine guarded by a trigger that mirrors @flank/core assertAlertTransition — so
-- deliver-once and "delivered is terminal" hold even against raw SQL (defense in depth, like 0002).

CREATE TABLE "alert_channel_config" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" "alert_channel" NOT NULL,
	"destination" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_channel_config_dest_uq" UNIQUE("workspace_id","channel","destination")
);
--> statement-breakpoint
ALTER TABLE "alert_channel_config" ADD CONSTRAINT "alert_channel_config_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_channel_config_workspace_idx" ON "alert_channel_config" USING btree ("workspace_id");--> statement-breakpoint

-- Reshape `alert` (the 0000 stub is empty — no writers exist yet — so adding NOT NULL columns is safe).
ALTER TABLE "alert" ADD COLUMN "channel_config_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "target" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_channel_config_id_alert_channel_config_id_fk" FOREIGN KEY ("channel_config_id") REFERENCES "public"."alert_channel_config"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Deliver-once per DESTINATION, not per channel type: a workspace may have N enabled configs of the
-- same channel (two email recipients, two webhooks), and each must receive the alert exactly once.
ALTER TABLE "alert" ADD CONSTRAINT "alert_delta_config_uq" UNIQUE("delta_id","channel_config_id");--> statement-breakpoint
CREATE INDEX "alert_workspace_status_idx" ON "alert" USING btree ("workspace_id","status");--> statement-breakpoint

-- Status-advance guard: immutable identity/provenance columns, the delivery state machine, and
-- "delivered requires proof + is terminal" (parallel to flank_guard_delta_update in 0002).
CREATE OR REPLACE FUNCTION flank_guard_alert_update() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
     OR NEW."delta_id" IS DISTINCT FROM OLD."delta_id"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."channel_config_id" IS DISTINCT FROM OLD."channel_config_id"
     OR NEW."target" IS DISTINCT FROM OLD."target"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."enqueued_at" IS DISTINCT FROM OLD."enqueued_at" THEN
    RAISE EXCEPTION 'alert %: identity/provenance columns are immutable (M3 delivery log)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'delivered' THEN
    RAISE EXCEPTION 'alert %: delivered is terminal — never re-sent or un-delivered', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (
    (OLD."status" = 'queued' AND NEW."status" IN ('delivered', 'failed'))
    OR (OLD."status" = 'failed' AND NEW."status" IN ('delivered', 'failed'))
  ) THEN
    RAISE EXCEPTION 'alert %: illegal status transition % -> %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'delivered' AND (NEW."provider_ref" IS NULL OR NEW."delivered_at" IS NULL) THEN
    RAISE EXCEPTION 'alert %: delivered requires provider_ref and delivered_at (proof of delivery)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER alert_no_delete BEFORE DELETE ON "alert" FOR EACH ROW EXECUTE FUNCTION flank_reject_mutation();--> statement-breakpoint
CREATE TRIGGER alert_guard_update BEFORE UPDATE ON "alert" FOR EACH ROW EXECUTE FUNCTION flank_guard_alert_update();
