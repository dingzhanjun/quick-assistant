// The background worker as its own small program: it runs ONLY the job loop (queued emails and texts with retries, the
// "order not acknowledged" reminders, housekeeping) and a tiny health endpoint. No Next.js, no pages, no routes, so the worker
// container needs a fraction of the web container's memory. In production it is bundled into dist/worker.cjs (see the
// `build:worker` script and apps/web/Dockerfile) and started with `node worker.cjs`; in development: `pnpm --filter web worker`.
import { createServer } from "node:http";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { jobsHealth, startJobWorker } from "../lib/jobs";

process.env.JOB_WORKER = "on"; // this process IS the worker

const port = Number(process.env.WORKER_HEALTH_PORT) || 3000;
const maxLag = Number(process.env.WORKER_LAG_SECONDS) || 120;

// GET /health: 200 while the database answers and no due job has waited longer than `maxLag` seconds, else 503. (Same rule as the web
// app's /api/health/worker.) Nothing else is served.
const server = createServer(async (req, res) => {
  if (req.method !== "GET" || req.url?.split("?")[0] !== "/health") {
    res.writeHead(404).end();
    return;
  }
  try {
    await db.execute(sql`select 1`);
    const h = await jobsHealth();
    const ok = h.oldestDueSeconds <= maxLag;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, lagSeconds: h.oldestDueSeconds }));
  } catch {
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
  }
});

server.listen(port, () => console.log(`[worker] health endpoint on :${port}/health`));
startJobWorker();

// docker stop: stop answering, let the process end (the loop's timer does not keep it alive).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
