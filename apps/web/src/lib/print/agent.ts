import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { printAgents } from "@/db/schema";

// Print-agent credentials. Both secrets are stored hashed only: the token (one per agent, shown to the agent once at
// pairing) and the one-time pairing code (shown to the restaurant owner once, valid 15 minutes).
export const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => `opa_${randomBytes(32).toString("base64url")}`;

// No 0/O/1/I/L: the code is read from a screen and typed on a Pi.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newPairingCode(): string {
  const b = randomBytes(8);
  const c = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
// The hash is of the code WITHOUT the dash and in upper case.
export const hashCode = (s: string) => hashSecret(normalizeCode(s));
export const PAIRING_MINUTES = 15;
// A code embedded in the SD-card setup file has to survive until the card is booted at the restaurant.
export const PAIRING_LONG_DAYS = 7;

// An agent is "online" when it has been heard from within this window (heartbeat every 30 s).
export const ONLINE_MS = 90_000;
export const isOnline = (lastSeenAt: Date | null, now = Date.now()) => !!lastSeenAt && now - lastSeenAt.getTime() < ONLINE_MS;

export type AuthedAgent = { id: string; tenantId: string };

// Resolves the bearer token of a /api/print/* request to its agent (platform-level lookup: the restaurant is not known
// until the token is). Revoked agents are refused. Stamps `last_seen_at`.
export async function authenticateAgent(req: Request): Promise<AuthedAgent | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer opa_")) return null;
  const [a] = await db
    .select({ id: printAgents.id, tenantId: printAgents.tenantId })
    .from(printAgents)
    .where(and(eq(printAgents.tokenHash, hashSecret(header.slice(7))), isNull(printAgents.revokedAt)));
  if (!a) return null;
  await db.update(printAgents).set({ lastSeenAt: new Date() }).where(eq(printAgents.id, a.id));
  return a;
}

// Small in-process limiter for the unauthenticated pairing endpoint (a code is 40 bits and expires, this only slows
// guessing down further).
const attempts = new Map<string, number[]>();
export function pairRateLimited(key: string, now = Date.now()): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  attempts.set(key, recent);
  if (attempts.size > 5000) attempts.clear();
  return recent.length > 10;
}
