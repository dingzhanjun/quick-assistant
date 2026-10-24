-- drizzle writes every column of an INSERT (unset ones as DEFAULT), and column privileges apply to that list, so the
-- restaurant role needs INSERT on `suspended` too. It is still unable to UPDATE it: an upsert on an existing row
-- (a suspended restaurant always has one) only touches the columns granted for UPDATE in migration 0016.
GRANT INSERT (suspended) ON tenant_settings TO order_app;
