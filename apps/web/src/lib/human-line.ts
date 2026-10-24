import { eq } from "drizzle-orm";
import { db } from "@/db";
import { phoneNumbers } from "@/db/schema";
import { normalizeE164 } from "./phone";

// Validates a human-line number (the phone callers are forwarded to on keypad 0 / "human agent").
// Empty = turn forwarding off. It may not be one of the agent's own numbers: forwarding a call to the agent line
// would just ring the agent again.
export async function parseHumanLine(
  raw: string,
): Promise<{ ok: true; e164: string | null } | { ok: false; error: string }> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, e164: null };
  const e164 = normalizeE164(trimmed);
  if (!e164) return { ok: false, error: "Use international format, e.g. +14155550123" };
  const [agentLine] = await db.select({ e164: phoneNumbers.e164 }).from(phoneNumbers).where(eq(phoneNumbers.e164, e164));
  if (agentLine) return { ok: false, error: "That is an agent phone number; the human line must be a different phone" };
  return { ok: true, e164 };
}
