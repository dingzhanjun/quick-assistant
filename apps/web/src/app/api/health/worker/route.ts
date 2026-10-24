import { NextResponse } from "next/server";
import { jobsHealth } from "@/lib/jobs";

// Is the background worker keeping up? 503 when a due job has been waiting more than WORKER_LAG_SECONDS (default 120): the
// worker is down or stuck, so emails and texts are not going out. Used by the worker container's health check and by uptime
// monitors. Reveals only that lag, not counts.
export async function GET() {
  try {
    const maxLag = Number(process.env.WORKER_LAG_SECONDS) || 120;
    const h = await jobsHealth();
    const ok = h.oldestDueSeconds <= maxLag;
    return NextResponse.json({ ok, lagSeconds: h.oldestDueSeconds }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
