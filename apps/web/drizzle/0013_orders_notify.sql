-- Live orders board: tell every listening web process which restaurant's orders changed.
-- The notification is delivered when the writing transaction COMMITS, so a listener that refreshes then sees the
-- whole order (items included). The payload is just the tenant id; the board refetches its own data.
CREATE OR REPLACE FUNCTION notify_orders_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('orders_changed', COALESCE(NEW.tenant_id, OLD.tenant_id));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER orders_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION notify_orders_changed();
