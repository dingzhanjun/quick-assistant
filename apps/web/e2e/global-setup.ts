import { execFileSync } from "node:child_process";
import path from "node:path";

export const STATE_FILE = path.join(__dirname, ".state.json");
export type E2EState = {
  run: string; tenantId: string; number: string; agentKey: string; dishId: string; adminEmail: string; adminCookie: string;
  owner: { email: string; password: string }; staff: { email: string; password: string };
};

// Seeding runs in a separate tsx process (see seed.ts): it needs the ESM-only auth library.
const seed = (cmd: "setup" | "teardown") =>
  execFileSync("pnpm", ["exec", "tsx", path.join(__dirname, "seed.ts"), cmd], { stdio: "inherit", env: process.env });

export default async function globalSetup() {
  seed("setup");
  return async () => seed("teardown");
}
