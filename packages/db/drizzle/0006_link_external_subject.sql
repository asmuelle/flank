-- Link a local app_user to its external IdP identity (FerrisKey OIDC `sub`). Nullable so existing
-- rows backfill on first login; unique so one IdP identity maps to exactly one local user.
ALTER TABLE "app_user" ADD COLUMN "external_subject" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_external_subject_unique" UNIQUE("external_subject");
