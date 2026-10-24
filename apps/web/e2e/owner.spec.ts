import { expect, test } from "./fixtures";
import { agentMenu, signIn, state } from "./helpers";

// Sign-ins are limited to 10/min per IP and this spec signs in once per test: use its own address (see print.spec.ts).
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
test.describe.configure({ mode: "serial" });

test("owner builds a menu with modifiers and the phone agent sees it", async ({ page }) => {
  await signIn(page, "owner");
  const run = state().run;

  // Modifier group with a surcharge option
  await page.goto("/dashboard/modifiers");
  await page.getByRole("button", { name: "Add group" }).click();
  await page.getByLabel("Group name").fill(`Size ${run}`);
  await page.getByLabel("Option name", { exact: true }).first().fill("Large");
  await page.getByLabel("Extra price").first().fill("2.00");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Size ${run}`)).toBeVisible();

  // Menu item that uses it
  await page.goto("/dashboard/menu");
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(`Burger ${run}`);
  await page.getByLabel("Price ($)").fill("9.50");
  await page.getByLabel(`Size ${run}`).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Burger ${run}`, { exact: true })).toBeVisible(); // exact: the switch has a hidden "<name> available" label

  const menu = await agentMenu(page);
  const burger = menu.items.find((i) => i.name === `Burger ${run}`);
  expect(burger).toBeTruthy();
  expect(burger!.modifierGroups[0].options[0]).toMatchObject({ name: "Large", priceDeltaCents: 200 });

  // Marking it sold out removes it from what the agent can sell
  // force: rsuite's Toggle keeps the real input under its visible track (users click the track, which toggles it)
  await page.getByRole("switch", { name: `Burger ${run} available` }).click({ force: true });
  await expect.poll(async () => (await agentMenu(page)).items.some((i) => i.name === `Burger ${run}`)).toBe(false);

  // Deleting asks first, with a confirmation dialog (not the browser's confirm): Cancel keeps it, confirming deletes it
  const row = page.getByRole("row").filter({ hasText: `Burger ${run}` });
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Item deleted")).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.goto("/dashboard/modifiers");
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByRole("alertdialog").getByText("It will be removed from all menu items.")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Group deleted")).toBeVisible();
});

test("owner groups dishes in categories (a dish can be in several) and the phone agent sees them", async ({ page }) => {
  await signIn(page, "owner");
  const run = state().run;

  await page.goto("/dashboard/categories");
  for (const name of [`Drinks ${run}`, `Veggie ${run}`]) {
    await page.getByRole("button", { name: "Add category" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  }
  // the same name twice (any case) is refused
  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByLabel("Name", { exact: true }).fill(`DRINKS ${run}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("A category with that name already exists")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // a dish in BOTH categories
  await page.goto("/dashboard/menu");
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(`Tea ${run}`);
  await page.getByLabel("Price ($)").fill("4.00");
  await page.getByRole("combobox", { name: "Categories" }).click();
  await page.getByRole("option", { name: `Drinks ${run}` }).click();
  await page.getByRole("option", { name: `Veggie ${run}` }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Item added")).toBeVisible();

  // the list shows it under each category
  await expect(page.getByRole("heading", { name: `Drinks ${run}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Veggie ${run}` })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `Tea ${run}` })).toHaveCount(2);

  const tea = (await agentMenu(page)).items.find((i) => i.name === `Tea ${run}`);
  expect(tea!.categories.map((c) => c.name)).toEqual([`Drinks ${run}`, `Veggie ${run}`]);

  // deleting a category leaves the dish
  await page.goto("/dashboard/categories");
  const row = page.getByRole("listitem").filter({ hasText: `Drinks ${run}` });
  await expect(row.getByText("1 dish")).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Category deleted")).toBeVisible();
  await expect.poll(async () => (await agentMenu(page)).items.find((i) => i.name === `Tea ${run}`)?.categories.map((c) => c.name)).toEqual([`Veggie ${run}`]);

  // tidy up so other specs see the original menu
  await page.getByRole("listitem").filter({ hasText: `Veggie ${run}` }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await page.goto("/dashboard/menu");
  const teaRow = page.getByRole("row").filter({ hasText: `Tea ${run}` });
  await teaRow.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(teaRow).toHaveCount(0);
});

test("owner imports a menu from a CSV file: preview first, errors block, then dishes and categories appear", async ({ page }) => {
  await signIn(page, "owner");
  const run = state().run;
  await page.goto("/dashboard/menu");

  // a file with a bad row is explained and cannot be imported
  await page.getByRole("button", { name: "Import CSV" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("CSV file").setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from(`name,price\nOk ${run},3\nBroken ${run},abc\n`) });
  await expect(dialog.getByRole("alert")).toContainText("Line 3");
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();

  // a good file (quoted comma, several categories): preview shows what will happen, then import
  const csv = `\uFEFFname,description,price,available,categories\r\nBun ${run},"Pork, steamed",2.50,yes,Dim sum ${run}; Snacks ${run}\r\n`;
  await dialog.getByLabel("CSV file").setInputFiles({ name: "menu.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(dialog.getByText("to update")).toContainText("1 new");
  await expect(dialog.getByText(`Dim sum ${run}, Snacks ${run}`)).toBeVisible();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Imported: 1 added, 0 updated, 2 new categories")).toBeVisible();

  await expect(page.getByRole("heading", { name: `Dim sum ${run}` })).toBeVisible();
  const bun = (await agentMenu(page)).items.find((i) => i.name === `Bun ${run}`);
  expect(bun!.categories.map((c) => c.name)).toEqual([`Dim sum ${run}`, `Snacks ${run}`]);

  // importing the same file again: nothing to do
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByRole("dialog").getByLabel("CSV file").setInputFiles({ name: "menu.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByRole("dialog").getByText("Nothing to import")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  // export gives the menu back in the same format
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const text = (await (await download).createReadStream().then((s) => new Promise<string>((res) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res(d)); })));
  expect(text).toContain(`Bun ${run}`);
  expect(text).toContain("Pork, steamed");

  // tidy up
  for (const n of [`Dim sum ${run}`, `Snacks ${run}`]) {
    await page.goto("/dashboard/categories");
    await page.getByRole("listitem").filter({ hasText: n }).getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Category deleted")).toBeVisible();
  }
  await page.goto("/dashboard/menu");
  const row = page.getByRole("row").filter({ hasText: `Bun ${run}` });
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});

test("the nav has a User menu that shows the email and signs out (the email is not in the bar)", async ({ page }) => {
  await signIn(page, "owner");
  const email = state().owner.email;
  await expect(page.getByText(email).first()).toBeHidden(); // not shown in the bar (the closed menu may exist in the DOM)
  await page.getByRole("button", { name: "User menu" }).click();
  await expect(page.getByText(email).first()).toBeVisible();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/dashboard"));
  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/dashboard$/);
});

test("owner sets opening hours; closed restaurants tell the agent so; phone numbers are read-only", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/settings");

  // numbers: shown, but no way to add one
  await expect(page.getByText(state().number)).toBeVisible();
  await expect(page.getByRole("button", { name: /add number/i })).toHaveCount(0);

  // Only open on a day that is not today => closed right now
  await page.getByLabel("Only answer during opening hours").check({ force: true });
  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
  const other = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].find((d) => d !== today)!;
  await page.getByLabel(other).check({ force: true });
  await page.getByRole("button", { name: "Save hours" }).click();
  await expect(page.getByText("Opening hours saved")).toBeVisible();
  expect((await agentMenu(page)).closed).toBe(true);

  // Back to 24/7
  await page.reload();
  await page.getByLabel("Only answer during opening hours").uncheck({ force: true });
  await page.getByRole("button", { name: "Save hours" }).click();
  await expect(page.getByText("Opening hours saved")).toBeVisible();
  await expect.poll(async () => (await agentMenu(page)).closed ?? false).toBe(false);
});

test("owner saves notification emails and they persist", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/settings");
  await page.getByRole("tab", { name: "Notifications" }).click(); // its own settings tab
  await expect(page).toHaveURL(/\/dashboard\/settings\/notifications$/);
  await page.getByLabel(/Send to/).fill("kitchen@example.com");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Notification settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Send to/)).toHaveValue("kitchen@example.com");
});

test("owner saves the restaurant address and the phone agent receives it", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/settings");
  await page.getByLabel("Address").fill("42 Harbor Road, Portland");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("Address saved")).toBeVisible();
  await expect.poll(async () => (await agentMenu(page)).address).toBe("42 Harbor Road, Portland");
});

test("owner sets the human line; the phone agent receives it; it cannot be the agent's own number", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/settings");
  await page.getByLabel("Human line").fill(state().number); // the agent's own number
  await page.getByRole("button", { name: "Save human line" }).click();
  await expect(page.getByText(/agent phone number/)).toBeVisible();

  await page.getByLabel("Human line").fill("+14155550123");
  await page.getByRole("button", { name: "Save human line" }).click();
  await expect(page.getByText("Human line saved")).toBeVisible();
  await expect.poll(async () => (await agentMenu(page)).transfer_number).toBe("+14155550123");
});

test("the customer's order page shows the restaurant's address and human line", async ({ page, browser }) => {
  // the two tests above saved "42 Harbor Road, Portland" and the human line +14155550123
  const s = state();
  const auth = { authorization: `Bearer ${s.agentKey}` };
  await signIn(page, "owner");
  const order = await (await page.request.post("/api/agent/orders", {
    headers: auth,
    data: { to: s.number, customer_name: "Linda", idempotency_key: `e2e-contact-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  })).json();
  await page.request.post("/api/agent/orders/sms", { headers: auth, data: { to: s.number, order_number: order.order_number, number: "404-555-0188" } });
  await page.goto("/dashboard/orders");
  const card = page.locator("li, div").filter({ hasText: "Linda" }).filter({ hasText: `Soup ${s.run}` }).last();
  const href = await card.getByRole("link", { name: "Customer's order page" }).getAttribute("href");

  const guest = await browser.newContext(); // the customer: not signed in
  const gp = await guest.newPage();
  await gp.goto(`${new URL(page.url()).origin}${href}`);
  await expect(gp.getByRole("heading", { name: `Order #${order.order_number}` })).toBeVisible();
  await expect(gp.getByRole("link", { name: "42 Harbor Road, Portland" }).first()).toBeVisible();
  const call = gp.getByRole("link", { name: "(415) 555-0123" }).first();
  await expect(call).toBeVisible();
  await expect(call).toHaveAttribute("href", "tel:+14155550123");
  await guest.close();
});
