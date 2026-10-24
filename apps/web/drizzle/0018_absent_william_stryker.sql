CREATE TABLE "print_agent_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"command" text NOT NULL,
	"args" jsonb,
	"requested_by" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "print_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp,
	"version" text,
	"lan_ip" text,
	"hostname" text,
	"info" jsonb,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"printer_id" uuid NOT NULL,
	"order_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp,
	"ticket" jsonb NOT NULL,
	"image" "bytea" NOT NULL,
	"error" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"printed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"device_key" text,
	"paper_width_mm" integer DEFAULT 80 NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" jsonb,
	"last_status_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "print_timing" text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "print_chinese" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "print_agent_commands" ADD CONSTRAINT "print_agent_commands_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_agent_commands" ADD CONSTRAINT "print_agent_commands_agent_id_print_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."print_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_agent_id_print_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."print_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_agent_commands_agent_idx" ON "print_agent_commands" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "print_agents_token_idx" ON "print_agents" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "print_agents_pairing_idx" ON "print_agents" USING btree ("pairing_code_hash");--> statement-breakpoint
CREATE INDEX "print_agents_tenant_idx" ON "print_agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_dedupe_idx" ON "print_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "print_jobs_queue_idx" ON "print_jobs" USING btree ("printer_id","status","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_order_idx" ON "print_jobs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "printers_tenant_idx" ON "printers" USING btree ("tenant_id");--> statement-breakpoint
-- Kitchen printing: row-level security like every other restaurant table (see 0016).
ALTER TABLE print_agents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE print_agent_commands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE printers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON print_agents TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON print_agent_commands TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON printers TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON print_jobs TO order_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- print_agents: the token / pairing-code hashes can be written (pairing) but never read back by restaurant code.
GRANT SELECT (id, tenant_id, name, version, lan_ip, hostname, info, last_seen_at, revoked_at, pairing_expires_at, created_at) ON print_agents TO order_app;
--> statement-breakpoint
GRANT INSERT ON print_agents TO order_app;
--> statement-breakpoint
GRANT UPDATE (name, token_hash, pairing_code_hash, pairing_expires_at, version, lan_ip, hostname, info, last_seen_at, revoked_at) ON print_agents TO order_app;
--> statement-breakpoint
GRANT DELETE ON print_agents TO order_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON print_agent_commands, printers, print_jobs TO order_app;
--> statement-breakpoint
-- the settings columns of this feature belong to the restaurant (in addition to the grants in 0016/0017)
GRANT INSERT (print_timing, print_chinese) ON tenant_settings TO order_app;
--> statement-breakpoint
GRANT UPDATE (print_timing, print_chinese) ON tenant_settings TO order_app;
--> statement-breakpoint
-- Wake the print agents' long-poll: a new or retried job for a restaurant is announced when its transaction commits.
CREATE OR REPLACE FUNCTION notify_print_jobs() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('print_jobs', NEW.tenant_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER print_jobs_notify
  AFTER INSERT ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION notify_print_jobs();
