-- The orders board shows "Printed / Printing / Print failed" per order, so a change of a ticket's status refreshes it
-- like an order change does (same channel, same payload: the tenant id).
CREATE OR REPLACE FUNCTION notify_print_job_status() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('orders_changed', NEW.tenant_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER print_jobs_status_notify
  AFTER UPDATE OF status ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION notify_print_job_status();
--> statement-breakpoint
-- A pairing attempt looks the code up by hash; at most one open code per hash (already unique), expiry is checked in code.
CREATE INDEX IF NOT EXISTS print_agent_commands_tenant_idx ON print_agent_commands (tenant_id, created_at);
