ALTER TABLE "tenant_settings" ADD COLUMN "timezone" text DEFAULT 'America/New_York' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "opening_hours" jsonb;