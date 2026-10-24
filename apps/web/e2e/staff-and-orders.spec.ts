import { expect, test } from "./fixtures";
import { signIn, state } from "./helpers";

test.describe.configure({ mode: "serial" });

test("an order from the phone agent shows up on the board and moves through the kitchen", async ({ page }) => {
  const s = state();
  await signIn(page, "staff"); // staff run the orders board

  const res = await page.request.post("/api/agent/orders", {
    headers: { authorization: `Bearer ${s.agentKey}` },
    data: { to: s.number, customer_name: "Pat", idempotency_key: `e2e-${s.run}`, items: [{ item_id: s.dishId, quantity: 2 }] },
  });
  expect(res.status()).toBe(200);

  await page.goto("/dashboard/orders");
  const card = page.locator("li, div").filter({ hasText: "Pat" }).filter({ hasText: `Soup ${s.run}` }).last();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Pickup: ASAP")).toBeVisible(); // no pickup time sent = as soon as possible
  // the first button is "Start preparing", or "Confirm & Print" when the restaurant prints only after confirming
  await card.getByRole("button", { name: /Start preparing|Confirm & Print/ }).click();
  await expect(card.getByRole("button", { name: "Mark ready" })).toBeVisible();
  await card.getByRole("button", { name: "Mark ready" }).click();
  await expect(card.getByRole("button", { name: "Complete" })).toBeVisible();
});

test("a new phone order appears on an open board within seconds, without reloading", async ({ page }) => {
  const s = state();
  await signIn(page, "staff");
  await page.goto("/dashboard/orders");
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 }); // the push connection is up
  const t0 = Date.now();
  const res = await page.request.post("/api/agent/orders", {
    headers: { authorization: `Bearer ${s.agentKey}` },
    data: { to: s.number, customer_name: "Livia", idempotency_key: `e2e-live-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  });
  expect(res.status()).toBe(200);
  // Polling is only a 60 s safety net while live, so a card this fast can only come from the push.
  await expect(page.getByText("Livia").first()).toBeVisible({ timeout: 4_000 });
  expect(Date.now() - t0).toBeLessThan(4_000);

  // Cancelling an order asks first: "Keep order" leaves it active, confirming cancels it
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByRole("alertdialog").getByText(/^Cancel order #\d+\?$/)).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Keep order" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Recent history" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByRole("heading", { name: "Recent history" })).toBeVisible();
});

test("staff cannot edit the menu, modifiers or settings", async ({ page }) => {
  await signIn(page, "staff");

  await page.goto("/dashboard/menu");
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.goto("/dashboard/modifiers");
  await expect(page.getByText("Only the restaurant owner can manage modifiers").first()).toBeVisible() // .first(): streamed pages briefly hold a hidden copy;
  await expect(page.getByRole("button", { name: "Add group" })).toHaveCount(0);

  await page.goto("/dashboard/settings");
  await expect(page.getByText("Only the restaurant owner can change settings").first()).toBeVisible();
  await page.goto("/dashboard/settings/notifications");
  await expect(page.getByText("Only the restaurant owner can change settings").first()).toBeVisible();
});

test("signed-out visitors are sent away from the dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/dashboard$/);
});

test("the customer can be texted a link to their order and the page follows the kitchen", async ({ page, browser }) => {
  const s = state();
  const auth = { authorization: `Bearer ${s.agentKey}` };
  // the agent is told texting is on
  const menu = await (await page.request.get(`/api/agent/menu?to=${encodeURIComponent(s.number)}`, { headers: auth })).json();
  expect(menu.text_orders).toBe(true);

  await signIn(page, "staff");
  const order = await (await page.request.post("/api/agent/orders", {
    headers: auth,
    data: { to: s.number, customer_name: "Gus", idempotency_key: `e2e-sms-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  })).json();
  // asks for the text, giving a number the way a caller says it
  const sms = await page.request.post("/api/agent/orders/sms", { headers: auth, data: { to: s.number, order_number: order.order_number, number: "(404) 555-0123" } });
  expect(await sms.json()).toEqual({ ok: true });
  // a number that is not a phone number is refused, and asking twice for the same one is harmless
  expect((await (await page.request.post("/api/agent/orders/sms", { headers: auth, data: { to: s.number, order_number: order.order_number, number: "12345678" } })).json()).reason).toBe("bad_number");
  expect((await (await page.request.post("/api/agent/orders/sms", { headers: auth, data: { to: s.number, order_number: order.order_number, number: "404-555-0123" } })).json()).duplicate).toBe(true);

  await page.goto("/dashboard/orders");
  const card = page.locator("li, div").filter({ hasText: "Gus" }).filter({ hasText: `Soup ${s.run}` }).last();
  // nothing is texted while the order waits: the text goes out when the restaurant confirms it
  await expect(card.getByText("they get the order link by text when you confirm")).toBeVisible({ timeout: 15_000 });
  const href = await card.getByRole("link", { name: "Customer's order page" }).getAttribute("href");
  expect(href).toMatch(/^\/orders\/[A-Za-z0-9_-]{22}$/);

  // the customer opens the link WITHOUT signing in
  const origin = new URL(page.url()).origin;
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(`${origin}${href}`);
  await expect(gp.getByRole("heading", { name: `Order #${order.order_number}` })).toBeVisible();
  await expect(gp.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(gp.getByText(`1 × Soup ${s.run}`)).toBeVisible();
  await expect(gp.getByText("+14045550123")).toHaveCount(0); // no phone numbers on the public page

  // the restaurant confirms it: the customer is texted now and the page moves on
  await card.getByRole("button", { name: "Start preparing" }).click();
  await expect(card.getByRole("button", { name: "Mark ready" })).toBeVisible();
  await expect(card.getByText("Order link texted to +14045550123")).toBeVisible({ timeout: 10_000 });
  await gp.reload();
  await expect(gp.getByText("Being prepared", { exact: true }).first()).toBeVisible(); // .first(): a streamed page briefly holds a hidden duplicate

  // a wrong link shows the not-found page and no order (the status stays 200 with cacheComponents, see CLAUDE.md)
  await gp.goto(`${origin}/orders/AAAAAAAAAAAAAAAAAAAAAA`);
  await expect(gp.getByText("This page could not be found").first()).toBeVisible();
  await expect(gp.getByRole("heading", { name: /^Order #/ })).toHaveCount(0);
  await guest.close();
});

test("the restaurant changes an order's pickup time: the card, the customer's page and the text follow", async ({ page, browser }) => {
  // 11:55 PM New York time must still be ahead (the restaurant's time zone in these tests)
  const nyNow = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  test.skip(nyNow >= "23:45", "too close to midnight in New York for a pickup at 11:55 PM");
  const s = state();
  const auth = { authorization: `Bearer ${s.agentKey}` };
  await signIn(page, "staff");
  const order = await (await page.request.post("/api/agent/orders", {
    headers: auth,
    data: { to: s.number, customer_name: "Pia", idempotency_key: `e2e-pickup-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  })).json();
  await page.request.post("/api/agent/orders/sms", { headers: auth, data: { to: s.number, order_number: order.order_number, number: "404-555-0166" } });

  await page.goto("/dashboard/orders");
  const card = page.locator("li, div").filter({ hasText: "Pia" }).filter({ hasText: `Soup ${s.run}` }).last();
  await expect(card.getByText("Pickup: ASAP")).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Change Pickup Time" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`Change pickup time for order #${order.order_number}`)).toBeVisible();
  await expect(dialog.getByText("The customer is texted the new time (+14045550166).")).toBeVisible();

  // the restaurant's time zone is America/New_York: pick 11:55 PM today
  await dialog.getByLabel("New pickup time").click();
  const popup = page.locator(".rs-picker-popup");
  await popup.getByText("23", { exact: true }).first().click(); // hours column
  await popup.getByText("55", { exact: true }).click(); // minutes column
  await popup.getByRole("button", { name: "OK" }).click();
  await dialog.getByRole("button", { name: "Save new time" }).click();
  await expect(page.getByText(/Pickup time changed/)).toBeVisible();

  // the card now shows the new time and what it was
  await expect(card.getByText(/changed, was ASAP/)).toBeVisible({ timeout: 10_000 });
  // (the board shows times in the VIEWER's time zone, so the exact clock text depends on the machine: only check it is no longer ASAP.
  // The customer's page below uses the restaurant's zone and is checked for 11:55 PM.)
  await expect(card.getByText("Pickup: ASAP")).toHaveCount(0);

  // the customer's own page shows it too
  const href = await card.getByRole("link", { name: "Customer's order page" }).getAttribute("href");
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(`${new URL(page.url()).origin}${href}`);
  await expect(gp.getByText("11:55 PM").first()).toBeVisible();
  await expect(gp.getByText("(updated by the restaurant)").first()).toBeVisible();
  await guest.close();

  // and it can be put back
  await card.getByRole("button", { name: "Change Pickup Time" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Use the original time" }).click();
  await expect(card.getByText("Pickup: ASAP")).toBeVisible({ timeout: 10_000 });
});
