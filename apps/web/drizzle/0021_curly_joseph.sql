ALTER TABLE "orders" ADD COLUMN "contact_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sms_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "text_order_link" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_public_token_idx" ON "orders" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "orders_contact_idx" ON "orders" USING btree ("contact_number","created_at");
--> statement-breakpoint
-- the restaurant controls this setting (in addition to the grants in 0016/0017/0018)
GRANT INSERT (text_order_link) ON tenant_settings TO order_app;
--> statement-breakpoint
GRANT UPDATE (text_order_link) ON tenant_settings TO order_app;
