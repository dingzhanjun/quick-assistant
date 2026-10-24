// The worker as its own program (src/worker/main.ts bundled to dist/worker.cjs): it sends queued jobs, answers /health and
// stops on SIGTERM. Runs with the other job tests (one at a time) because a running worker sends every due job in the database.
// Needs a migrated Postgres (DATABASE_URL).
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { eq, like } from "drizzle-orm";

const run = randomUUID().slice(0, 8);
const port = 20000 + Math.floor(Math.random() * 20000);
let child: ChildProcess | null = null;
let output = "";
type Db = typeof import("../src/db")["db"];
let db: Db;
let S: typeof import("../src/db/schema");

before(async () => {
  ({ db } = await import("../src/db"));
  S = await import("../src/db/schema");
  execFileSync("pnpm", ["build:worker"], { cwd: process.cwd(), stdio: "pipe" }); // the same command the Docker build runs
  assert.ok(existsSync("dist/worker.cjs"));
});
after(async () => {
  child?.kill("SIGKILL");
  await db.delete(S.jobs).where(like(S.jobs.dedupeKey, `jobs-worker-${run}%`));
  process.exit(0);
});

const health = async () => fetch(`http://127.0.0.1:${port}/health`).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; lagSeconds?: number } }));
async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}\n${output}`);
}

test("the bundle is small and needs no web framework", () => {
  const size = statSync("dist/worker.cjs").size;
  assert.ok(size < 2_000_000, `bundle is ${size} bytes`);
  const text = readFileSync("dist/worker.cjs", "utf8");
  assert.ok(!text.includes("next/server") && !text.includes("better-auth") && !text.includes("betterAuth"), "the worker must not pull in Next.js or the auth library");
});

test("started on its own, it sends a queued text, answers /health and stops cleanly on SIGTERM", async () => {
  const [job] = await db.insert(S.jobs).values({ type: "sms", payload: { to: "+14045550190", text: "worker test" }, dedupeKey: `jobs-worker-${run}-1` }).returning();
  child = spawn(process.execPath, [path.resolve("dist/worker.cjs")], {
    env: { ...process.env, WORKER_HEALTH_PORT: String(port), JOB_TICK_SECONDS: "1", SMS_PROVIDER: "log", JOB_WORKER: "off" /* the entry point forces itself on */ },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));

  const h = await until(async () => { const r = await health(); return r.status === 200 ? r : undefined; }, "a healthy /health");
  assert.equal(h.body.ok, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404, "only /health is served");

  await until(async () => (await db.select().from(S.jobs).where(eq(S.jobs.id, job.id)))[0]?.status === "done", "the job to be sent");
  assert.match(output, /\[sms:dev\] to=\+14045550190/);
  assert.match(output, /worker started/);

  const exited = new Promise<number | null>((resolve) => child!.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 6000))]), 0, "exits 0 on SIGTERM");
  child = null;
});
