ALTER TABLE "tenant_settings" ADD COLUMN "notify_emails" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "notify_new_orders" boolean DEFAULT true NOT NULL;