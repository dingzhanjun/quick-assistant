import { expect, test } from "./fixtures";
import { pick, signIn, state } from "./helpers";

// Runs last (file name) so it can look for the entries the other specs produced.
test("platform admin sees the audit trail of what happened in the restaurant", async ({ page, context }) => {
  const s = state();
  await context.addCookies([{ name: "better-auth.session_token", value: s.adminCookie, url: "http://localhost:3100" }]);

  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();

  // Filter to this run's restaurant (the seed named it "E2E Diner <run>")
  await pick(page, "Restaurant", `E2E Diner ${s.run}`);
  await page.getByRole("button", { name: "Filter" }).click();

  // The restaurant's log is newest first, 50 per page, and the other specs write many entries: look at each action through the
  // action filter instead of hoping it is still on the first page. `who` is checked on the matching entries.
  const expected: [string, string | null][] = [
    ["menu_item.created", s.owner.email], ["menu_item.availability_changed", s.owner.email], ["modifier_group.created", s.owner.email],
    ["settings.hours_updated", s.owner.email], ["settings.notifications_updated", s.owner.email],
    ["order.created", "voice agent"], ["order.updated", s.staff.email],
  ];
  for (const [action, who] of expected) {
    await pick(page, "Action", new RegExp(`^${action.replace(".", "\\.")}(:|$)`));
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByText(action, { exact: true }).first()).toBeVisible();
    if (who) await expect(page.getByText(who).first()).toBeVisible();
  }

  // action filter narrows the list
  await pick(page, "Action", /^order\.\* \(all\)/);
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByText("menu_item.created", { exact: true })).toHaveCount(0);
  await expect(page.getByText("order.created", { exact: true }).first()).toBeVisible();
});

test("platform admin is asked before suspending a restaurant", async ({ page, context }) => {
  const s = state();
  await context.addCookies([{ name: "better-auth.session_token", value: s.adminCookie, url: "http://localhost:3100" }]);
  await page.goto("/admin");
  const row = page.getByRole("row").filter({ hasText: `E2E Diner ${s.run}` });
  await expect(row.getByRole("cell").nth(1)).toHaveText("2"); // owner + staff (the members count was always 0 before)
  await row.getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByRole("alertdialog").getByText(`Suspend E2E Diner ${s.run}?`)).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(row.getByRole("button", { name: "Suspend" })).toBeVisible(); // nothing happened
  await row.getByRole("button", { name: "Suspend" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Suspend" }).click();
  await expect(row.getByRole("button", { name: "Reactivate" })).toBeVisible();
  await row.getByRole("button", { name: "Reactivate" }).click(); // reactivating needs no confirmation
  await expect(row.getByRole("button", { name: "Suspend" })).toBeVisible();
});

test("restaurant owners cannot open the audit log", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/admin/audit");
  // (with cacheComponents the not-found page streams in with status 200, so check the content)
  await expect(page.getByText("This page could not be found")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit log" })).toHaveCount(0);
});

test("platform admin sees the email & text queue and its worker health", async ({ page, context }) => {
  const s = state();
  await context.addCookies([{ name: "better-auth.session_token", value: s.adminCookie, url: "http://localhost:3100" }]);
  await page.goto("/admin");
  await page.getByRole("link", { name: /Email & text queue/ }).click();
  await expect(page.getByRole("heading", { name: "Background jobs" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/Worker healthy|The worker is not keeping up/);
  await page.getByRole("link", { name: /^Texts$/ }).click();
  await expect(page).toHaveURL(/type=sms/);
  await page.getByRole("link", { name: /^Failed/ }).click();
  await expect(page.getByRole("heading", { name: "Background jobs" })).toBeVisible();
  // the worker health endpoint is public and answers 200/503 with the lag only
  const res = await page.request.get("/api/health/worker");
  expect([200, 503]).toContain(res.status());
  expect(Object.keys(await res.json()).sort()).toEqual(expect.arrayContaining(["ok"]));
});
