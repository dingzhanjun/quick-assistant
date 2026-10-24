import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };
const client = globalForDb.pg ?? postgres(process.env.DATABASE_URL!, {
    // Hosted Postgres poolers (Neon, Supabase, pgbouncer) in transaction mode reject prepared
    // statements. Small speed cost, works everywhere.
    prepare: false,
  });
if (process.env.NODE_ENV !== "production") globalForDb.pg = client;

export const db = drizzle(client, { schema });

// Dedicated connection for LISTEN/NOTIFY (live updates). LISTEN does not work through a transaction-mode pooler
// (pgbouncer), so DATABASE_LISTEN_URL can point at the direct database address; default: same as DATABASE_URL.
export function createListenClient() {
  return postgres(process.env.DATABASE_LISTEN_URL || process.env.DATABASE_URL!, { max: 1, prepare: false });
}
