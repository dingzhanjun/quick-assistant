import { NextResponse } from "next/server";
import { printHub } from "@/lib/order-events";
import { authenticateAgent } from "@/lib/print/agent";
import { claimWork } from "@/lib/print/queue";

const SAFETY_MS = 3000; // re-check this often even if no notification arrives (LISTEN down, a lease that just expired)

// Long-poll: returns the next ticket or service command as soon as there is one, else 204 after `wait` seconds (max 30).
// A new ticket wakes it through Postgres LISTEN/NOTIFY, so printing starts about a second after the order is saved.
export async function GET(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const wait = Math.min(30, Math.max(0, Number(new URL(req.url).searchParams.get("wait") ?? 25) || 0));
  const deadline = Date.now() + wait * 1000;

  let wake: (() => void) | null = null;
  const unsubscribe = printHub.subscribe(agent.tenantId, () => wake?.());
  try {
    for (;;) {
      const work = await claimWork(agent);
      if (work) return NextResponse.json(work);
      const left = deadline - Date.now();
      if (left <= 0 || req.signal.aborted) return new Response(null, { status: 204 });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, SAFETY_MS));
        wake = () => { clearTimeout(t); resolve(); };
        req.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  } finally {
    unsubscribe();
  }
}
