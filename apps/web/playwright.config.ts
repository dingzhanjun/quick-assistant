import { defineConfig } from "@playwright/test";

// Browser tests for the dashboard (LAUNCH_PLAN P4.3). They need a migrated Postgres (DATABASE_URL) and the
// production build: `pnpm build` first (CI does), then `pnpm test:e2e`. The server runs on :3100 so it never
// collides with `pnpm dev:web`. Test users/restaurants are created and removed by e2e/global-setup.ts.
const PORT = 3100;
// One agent key for the server and the seed script (which inherits this process's env).
process.env.AGENT_API_KEY ??= "e2e-agent-key";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      BETTER_AUTH_URL: `http://localhost:${PORT}`,
      AGENT_API_KEY: process.env.AGENT_API_KEY!,
      AUTH_IP_HEADER: "x-forwarded-for",
      SMS_PROVIDER: "log", // texting on: messages are printed to the server console, nothing is sent
      PRINT_AGENT_VERSION: "1.0.0",
      PRINT_AGENT_BASE_URL: "https://releases.example.test/printer-v1.0.0", // both set = override: enables the SD-card setup files
    },
  },
});
