import fs from "node:fs";
import path from "node:path";

// Which print-agent version the platform wants and where its files are. The web image carries the agent binaries in
// public/printer/ (built by apps/web/Dockerfile from apps/printer-agent; VERSION, order-printer-linux-<arch> and .sha256), so the
// server hosts its own downloads at <BETTER_AUTH_URL>/printer. PRINT_AGENT_VERSION + PRINT_AGENT_BASE_URL (both set) override that
// to point at a release hosted elsewhere. Null = this build has no agent files and no override (the dashboard hides the SD-card
// setup and agents are not told to update).
export type AgentRelease = { version: string; baseUrl: string };

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

type Env = Record<string, string | undefined>;

export function agentRelease(opts: { env?: Env; dir?: string } = {}): AgentRelease | null {
  const env = opts.env ?? process.env;
  const version = env.PRINT_AGENT_VERSION?.trim();
  const base = env.PRINT_AGENT_BASE_URL?.trim();
  if (version && base) return { version, baseUrl: base.replace(/\/+$/, "") };

  const dir = opts.dir ?? path.join(process.cwd(), "public", "printer");
  const site = env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  if (!site) return null;
  try {
    const v = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
    // the files must really be there: at least the 64-bit Pi binary and its checksum
    if (!VERSION_RE.test(v) || !fs.existsSync(path.join(dir, "order-printer-linux-arm64")) || !fs.existsSync(path.join(dir, "order-printer-linux-arm64.sha256"))) return null;
    return { version: v, baseUrl: `${site}/printer` };
  } catch {
    return null;
  }
}
