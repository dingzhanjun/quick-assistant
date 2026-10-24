import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT, audit } from "@/lib/audit";
import { isAgentRequest } from "@/lib/agent-auth";
import { resolveAgentTenant } from "@/lib/agent-tenant";

const body = z.object({
  to: z.string(),
  call_id: z.string().min(1).max(200),
  via: z.enum(["keypad", "request"]), // pressed 0, or asked for a human
  ok: z.boolean(),
  error: z.string().max(300).optional(),
});

// The agent reports that it forwarded (or failed to forward) a call to the restaurant's human line.
export async function POST(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const t = await resolveAgentTenant(parsed.data.to);
  if ("response" in t) return t.response;
  const { call_id, via, ok, error } = parsed.data;
  await audit({
    action: ok ? "call.transferred" : "call.transfer_failed", actor: AGENT, tenantId: t.tenantId, entityType: "call", entityId: call_id,
    summary: ok ? `Call forwarded to the human line (${via === "keypad" ? "pressed 0" : "asked for a person"})` : `Forwarding to the human line failed: ${error ?? "unknown error"}`,
    details: { via, ...(error ? { error } : {}) },
  });
  return NextResponse.json({ ok: true });
}
