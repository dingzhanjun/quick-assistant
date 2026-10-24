-- Row-level security: a SECOND lock behind the tenant checks in the code.
--
-- Code that works for ONE restaurant runs inside withTenant() (src/lib/tenant-db.ts): a transaction that switches to the
-- low-privilege role `order_app` and sets app.tenant_id. Under that role the database itself only shows and accepts rows
-- of that restaurant, so a forgotten `where tenant_id = ...` returns nothing instead of leaking another restaurant's data.
-- With no tenant set, nothing matches (fail closed). The role also cannot read the audit log, change a restaurant's
-- `suspended` flag or its phone numbers: those stay with the platform admin.
--
-- The application's normal database user keeps full access (platform admin pages, background jobs, audit log, the agent's
-- first lookup of a dialed number) and switches into order_app per request via set_config('role', ...).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'order_app') THEN
    CREATE ROLE order_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
-- the connecting user must be allowed to SET ROLE order_app (a superuser always is; managed databases need this grant)
GRANT order_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO order_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_items, modifier_groups, modifier_options, menu_item_modifier_groups, orders, order_items TO order_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON calls TO order_app;
--> statement-breakpoint
GRANT SELECT ON phone_numbers TO order_app;
--> statement-breakpoint
-- tenant_settings: every column EXCEPT `suspended` (platform-controlled)
GRANT SELECT ON tenant_settings TO order_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, transfer_number, notify_emails, notify_new_orders, address, timezone, opening_hours, updated_at) ON tenant_settings TO order_app;
--> statement-breakpoint
GRANT UPDATE (transfer_number, notify_emails, notify_new_orders, address, timezone, opening_hours, updated_at) ON tenant_settings TO order_app;
--> statement-breakpoint
-- who is in the restaurant (not row-secured: read only)
GRANT SELECT ON "member", "user", "organization", "invitation" TO order_app;
--> statement-breakpoint
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE modifier_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON menu_items TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON modifier_groups TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON modifier_options TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON orders TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calls TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON phone_numbers TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_settings TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- tables without their own tenant_id: ownership comes from the parent row (which is itself row-secured)
CREATE POLICY tenant_isolation ON order_items TO order_app
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.tenant_id = current_setting('app.tenant_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON menu_item_modifier_groups TO order_app
  USING (EXISTS (SELECT 1 FROM menu_items m WHERE m.id = menu_item_modifier_groups.menu_item_id AND m.tenant_id = current_setting('app.tenant_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM menu_items m WHERE m.id = menu_item_modifier_groups.menu_item_id AND m.tenant_id = current_setting('app.tenant_id', true)));
