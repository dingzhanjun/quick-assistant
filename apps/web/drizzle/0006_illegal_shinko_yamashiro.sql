CREATE TABLE "blocked_numbers" (
	"e164" text PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"call_id" text NOT NULL,
	"caller_number" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "caller_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_call_id_idx" ON "calls" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "calls_tenant_started_idx" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_caller_started_idx" ON "calls" USING btree ("caller_number","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_idem_idx" ON "orders" USING btree ("tenant_id","idempotency_key");