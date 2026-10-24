CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"name_zh" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_item_categories" (
	"menu_item_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "menu_item_categories_menu_item_id_category_id_pk" PRIMARY KEY("menu_item_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_categories" ADD CONSTRAINT "menu_item_categories_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_categories" ADD CONSTRAINT "menu_item_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_tenant_idx" ON "categories" USING btree ("tenant_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON categories, menu_item_categories TO order_app;
--> statement-breakpoint
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE menu_item_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON categories TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON menu_item_categories TO order_app
  USING (EXISTS (SELECT 1 FROM menu_items m WHERE m.id = menu_item_categories.menu_item_id AND m.tenant_id = current_setting('app.tenant_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM menu_items m WHERE m.id = menu_item_categories.menu_item_id AND m.tenant_id = current_setting('app.tenant_id', true))
    AND EXISTS (SELECT 1 FROM categories c WHERE c.id = menu_item_categories.category_id AND c.tenant_id = current_setting('app.tenant_id', true)));
