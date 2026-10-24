// Runs once when the server process starts. Starts the background job worker (email retries, unacknowledged-order
// alerts, housekeeping) in the Node.js runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startJobWorker } = await import("./lib/jobs");
    startJobWorker();
    // A brand-new system: seed the first platform admin when PLATFORM_ADMIN_PASSWORD is set (no-op otherwise).
    const { ensureBootstrapAdmin } = await import("./lib/bootstrap-admin");
    ensureBootstrapAdmin().catch((e) => console.error("[bootstrap] could not create the platform admin", e));
  }
}
