import fs from "node:fs";
import { expect, test } from "./fixtures";
import { signIn, state } from "./helpers";

test.describe.configure({ mode: "serial" });
// Sign-ins are rate limited per IP (10/min). The test server reads the client IP from x-forwarded-for, so this spec uses
// its own (random) address and does not eat into the other specs' budget.
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

test("owner adds a print agent, a fake agent pairs and prints a phone order, the board shows Printed and can reprint", async ({ page }) => {
  const s = state();
  await signIn(page, "owner");
  // Settings is split into tabs; printing has its own
  await page.goto("/dashboard/settings");
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Team" }).click();
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  await page.getByRole("tab", { name: "Kitchen printing" }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings\/printing$/);

  // Add a print agent: the pairing code is shown once.
  await page.getByLabel("Add a print agent").fill("Kitchen Pi");
  await page.getByRole("button", { name: "Get pairing code" }).click();
  const code = (await page.locator("p.font-mono").first().innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(page.getByText("Waiting to pair")).toBeVisible();

  // The Pi side (a fake agent): pair, then it shows up as a printer in Settings.
  const pair = await page.request.post("/api/print/pair", {
    data: { code, version: "0.1.0", hostname: "kitchen-pi", lan_ip: "192.168.1.47", devices: [{ key: "lp0" }] },
  });
  expect(pair.status()).toBe(200);
  const { token } = (await pair.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  await page.reload();
  await expect(page.getByText("192.168.1.47")).toBeVisible();
  await expect(page.locator("input[value='Kitchen']")).toBeVisible(); // the registered printer

  // A phone order creates a ticket; the agent collects, downloads and acknowledges it.
  const order = await page.request.post("/api/agent/orders", {
    headers: { authorization: `Bearer ${s.agentKey}` },
    data: { to: s.number, customer_name: "Printa", idempotency_key: `e2e-print-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  });
  expect(order.status()).toBe(200);
  let job: { type: string; job: { id: string } } | null = null;
  for (let i = 0; i < 10 && !job; i++) {
    const r = await page.request.get("/api/print/poll?wait=3", { headers: auth });
    if (r.status() === 200) job = await r.json();
  }
  expect(job?.type).toBe("job");
  await page.goto("/dashboard/orders");
  const card = page; // this restaurant has just this one order on the board
  await expect(card.getByText("Printing…")).toBeVisible({ timeout: 10_000 });
  const img = await page.request.get(`/api/print/jobs/${job!.job.id}/image`, { headers: auth });
  expect(img.headers()["content-type"]).toBe("image/png");
  await page.request.post(`/api/print/jobs/${job!.job.id}/result`, { headers: auth, data: { ok: true } });
  await expect(card.getByText("Printed", { exact: true })).toBeVisible({ timeout: 10_000 }); // live update, no reload

  // Reprint queues another ticket for the agent.
  await card.getByRole("button", { name: "Reprint" }).first().click();
  const again = await page.request.get("/api/print/poll?wait=5", { headers: auth });
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { job: { kind: string } }).job.kind).toBe("reprint");

  // Print after confirmation: a new order is NOT printed until staff press "Confirm & Print" on its card.
  await page.goto("/dashboard/settings/printing");
  await page.getByLabel("Only after the restaurant confirms it: press Confirm & Print on the order card").check({ force: true });
  await page.getByRole("button", { name: "Save printing settings" }).click();
  await expect(page.getByText("Printing settings saved")).toBeVisible();
  // the toast text is the same for every save: prove it was really saved by reloading
  await page.reload();
  await expect(page.getByLabel("Only after the restaurant confirms it: press Confirm & Print on the order card")).toBeChecked();
  const held = await page.request.post("/api/agent/orders", {
    headers: { authorization: `Bearer ${s.agentKey}` },
    data: { to: s.number, customer_name: "Holdy", idempotency_key: `e2e-confirm-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  });
  expect(held.status()).toBe(200);
  await page.goto("/dashboard/orders");
  const heldCard = page.locator("li, div").filter({ hasText: "Holdy" }).filter({ hasText: `Soup ${s.run}` }).last();
  await expect(heldCard.getByText("Not printed")).toBeVisible({ timeout: 10_000 });
  await expect(heldCard.getByRole("button", { name: "Start preparing" })).toHaveCount(0); // the button is "Confirm & Print"
  expect((await page.request.get("/api/print/poll?wait=2", { headers: auth })).status()).toBe(204); // nothing was queued
  await heldCard.getByRole("button", { name: "Confirm & Print" }).click();
  await expect(heldCard.getByRole("button", { name: "Mark ready" })).toBeVisible();
  const confirmed = await page.request.get("/api/print/poll?wait=5", { headers: auth });
  expect(confirmed.status()).toBe(200);
  expect(((await confirmed.json()) as { job: { kind: string } }).job.kind).toBe("new");
  // back to printing at once, so the rest of the suite behaves as before
  await page.goto("/dashboard/settings/printing");
  await page.getByLabel("Immediately, as soon as the order is taken").check({ force: true });
  await page.getByRole("button", { name: "Save printing settings" }).click();
  await expect(page.getByText("Printing settings saved")).toBeVisible();
  await page.reload(); // the toast alone is not proof: later specs must find the setting restored
  await expect(page.getByLabel("Immediately, as soon as the order is taken")).toBeChecked();

  // Clean up so the next spec (the real Go agent) starts with no printer of its own: remove this one and its agent.
  await page.goto("/dashboard/settings/printing");
  // scoped to the printer row: the Team section above has its own Remove buttons
  await page.locator("div.rounded-lg.border").filter({ has: page.locator("input[value='Kitchen']") }).getByRole("button", { name: "Remove" }).click();
  // a confirmation dialog, not the browser's: Cancel leaves the printer alone, confirming removes it
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText('Remove printer "Kitchen"?')).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("input[value='Kitchen']")).toBeVisible();
  await page.locator("div.rounded-lg.border").filter({ has: page.locator("input[value='Kitchen']") }).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Printer removed")).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Revoked", { exact: true }).first()).toBeVisible();
  // a revoked agent can simply be deleted (with its printer and tickets)
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No print agent yet.")).toBeVisible();
});

test("owner downloads the SD-card setup files for a monitor-less Pi", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/settings/printing");

  // theme switch: Tailwind's dark class AND React Suite's dark theme follow it, and it survives a reload
  await page.getByRole("button", { name: /Theme: System/ }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.locator(".rs-theme-dark").first()).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: /Theme: Dark/ }).click();
  await page.getByRole("menuitem", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  await page.getByText("Set up a new Pi without a monitor").first().click(); // .first(): a streamed page briefly holds a hidden copy
  await page.getByLabel("Pi host name").fill("e2e-kitchen-pi");
  await page.getByLabel("Wi-Fi name (leave empty for a network cable)").fill("E2E Wi-Fi");
  await page.getByLabel("Wi-Fi password").fill("correct horse battery");

  const names: string[] = [];
  let userData = "";
  page.on("download", async (d) => {
    names.push(d.suggestedFilename());
    if (d.suggestedFilename() === "user-data") userData = fs.readFileSync((await d.path())!, "utf8");
  });
  await page.getByRole("button", { name: "Create setup files" }).click();
  // nothing downloads by itself (a browser blocks the second automatic download); each file has its own button
  await expect(page.getByText("Your setup files are ready.")).toBeVisible();
  expect(names).toEqual([]);
  await page.getByRole("button", { name: "Download user-data" }).click();
  await page.getByRole("button", { name: "Download network-config" }).click();
  await expect.poll(() => [...names].sort()).toEqual(["network-config", "user-data"]);
  await expect.poll(() => userData).toContain("#cloud-config");
  expect(userData).toContain('hostname: "e2e-kitchen-pi"');
  expect(userData).toContain("SERVER=http://localhost:3100"); // the platform's own address
  expect(userData).toContain("BASE=https://releases.example.test/printer-v1.0.0");
  expect(userData).not.toContain("correct horse battery");
  await expect(page.getByText("Waiting to pair").first()).toBeVisible({ timeout: 15_000 }); // the agent row exists now
  // never paired: delete it again so the next spec (the real Go agent) finds no other agent
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No print agent yet.")).toBeVisible();
});
