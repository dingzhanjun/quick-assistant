import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { signIn, state } from "./helpers";

// The REAL Go print agent against the REAL server: pair with a code from Settings, print a phone order to a file that
// stands in for /dev/usb/lp0, answer a service command, and stop when the owner revokes it.
const AGENT_DIR = path.resolve(__dirname, "../../printer-agent");
let haveGo = true;
try { execFileSync("go", ["version"], { stdio: "ignore" }); } catch { haveGo = false; }

test.describe.configure({ mode: "serial" });
test.skip(!haveGo, "Go is not installed");
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.78.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

test("the Go agent pairs, prints a phone order, runs a service command and stops when revoked", async ({ page }) => {
  test.setTimeout(150_000);
  const s = state();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "printer-e2e-"));
  const bin = path.join(tmp, "order-printer");
  execFileSync("go", ["build", "-o", bin, "./cmd/order-printer"], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: "0" } });
  const devDir = path.join(tmp, "dev");
  fs.mkdirSync(devDir);
  const lp0 = path.join(devDir, "lp0");
  fs.writeFileSync(lp0, "");
  const env = { ...process.env, ORDER_PRINTER_CONFIG: path.join(tmp, "cfg", "config.json"), ORDER_PRINTER_STATE: path.join(tmp, "state"), ORDER_PRINTER_DEV_DIR: devDir, ORDER_PRINTER_PORT: String(20000 + Math.floor(Math.random() * 20000)) };
  let proc: ChildProcess | null = null;
  const output: string[] = [];
  try {
    await signIn(page, "owner");
    await page.goto("/dashboard/settings/printing");
    await page.getByLabel("Add a print agent").fill("E2E Pi");
    await page.getByRole("button", { name: "Get pairing code" }).click();
    const code = (await page.locator("p.font-mono").first().innerText()).trim();

    const base = `http://localhost:3100`;
    const paired = execFileSync(bin, ["pair", code, "--server", base], { env, encoding: "utf8" });
    expect(paired).toContain("paired with");
    expect(fs.statSync(env.ORDER_PRINTER_CONFIG).mode & 0o777).toBe(0o600);

    proc = spawn(bin, ["run"], { env });
    proc.stderr?.on("data", (d) => output.push(String(d)));

    // a phone order is printed by the agent: the "printer file" receives an ESC/POS raster image and a cut
    const order = await page.request.post("/api/agent/orders", {
      headers: { authorization: `Bearer ${s.agentKey}` },
      data: { to: s.number, customer_name: "GoAgent", idempotency_key: `e2e-go-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
    });
    expect(order.status()).toBe(200);
    await expect.poll(() => fs.readFileSync(lp0).includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])), { timeout: 20_000, message: output.join("") }).toBe(true);
    expect(fs.readFileSync(lp0).includes(Buffer.from([0x1d, 0x56, 0x42, 0x03]))).toBe(true); // partial cut

    // the dashboard shows it as printed, and the agent as online with its details
    await page.goto("/dashboard/orders");
    await expect(page.getByText("Printed", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.goto("/dashboard/settings/printing");
    await expect(page.getByText("Online", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Ready").first()).toBeVisible();

    // a service command round trip: Show the last log lines
    await page.getByRole("button", { name: "Show the last log lines" }).click();
    await expect(page.getByText(/paired with .*; running/).first()).toBeVisible({ timeout: 20_000 });

    // revoking cuts the agent off: it renames its config and falls back to unpaired mode
    await page.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect.poll(() => fs.existsSync(env.ORDER_PRINTER_CONFIG + ".revoked"), { timeout: 40_000, message: output.join("") }).toBe(true);

    // and the revoked agent can be deleted: it and its printer disappear from Settings
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No print agent yet.")).toBeVisible();
  } finally {
    proc?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
