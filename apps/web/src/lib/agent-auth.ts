import { timingSafeEqual } from "node:crypto";

// Shared-secret check for the voice agent's calls into /api/agent/*.
export function isAgentRequest(req: Request): boolean {
  const expected = process.env.AGENT_API_KEY;
  const header = req.headers.get("authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
