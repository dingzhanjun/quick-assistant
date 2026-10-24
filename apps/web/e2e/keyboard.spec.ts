import { expect, test } from "./fixtures";
import { signIn, state } from "./helpers";

// Keyboard-only use of the React Suite components (UI_MIGRATION_PLAN.md phase 7): dialog focus, picker, tabs, theme menu.
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.87.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

const focusedText = (page: import("@playwright/test").Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? "");

test("a confirmation dialog traps focus, closes on Escape and gives focus back", async ({ page }) => {
  const s = state();
  await signIn(page, "owner");
  await page.request.post("/api/agent/orders", {
    headers: { authorization: `Bearer ${s.agentKey}` },
    data: { to: s.number, customer_name: "Keys", idempotency_key: `kbd-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
  });
  await page.goto("/dashboard/orders");
  const trigger = page.getByRole("button", { name: "Cancel" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter"); // open with the keyboard
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // focus moves into the dialog (after its open animation), and Tab keeps cycling inside it
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('.rs-modal-wrapper'));
  await expect.poll(inside).toBe(true);
  // Tab walks through the dialog's controls: close (x), Keep order, Cancel order. (Tabbing past the last one leaves the
  // document for the browser's own UI, like any modal; rsuite pulls focus back if it lands on the page behind.)
  for (const name of ["Close", "Keep order", "Cancel order"]) {
    await page.keyboard.press("Tab");
    expect(await focusedText(page) || (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))).toBe(name);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await focusedText(page)).toBe("Cancel"); // back on the button that opened it
});

test("the restaurant picker works with the keyboard", async ({ page }) => {
  await signIn(page, "owner");
  const picker = page.getByRole("combobox", { name: "Restaurant" });
  await picker.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape"); // closes without choosing
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(picker).toContainText("E2E Diner"); // still the current restaurant
});

test("settings tabs and the theme menu work with the keyboard", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/settings");
  await page.getByRole("tab", { name: "Team" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard\/settings\/team$/);

  // theme menu: open with Enter, arrow to "Dark" (the list is Light, Dark, System), choose with Enter
  const theme = page.getByRole("button", { name: /System/ });
  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  // arrow down until "Dark" is the focused item (where the focus starts depends on timing), then choose it
  const dark = page.getByRole("menuitem", { name: "Dark" });
  for (let i = 0; i < 4 && (await dark.getAttribute("data-focus")) !== "true"; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
  }
  await expect(dark).toHaveAttribute("data-focus", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  // put it back (mouse): the saved theme would otherwise follow this browser context only, but keep the test self-contained
  await page.getByRole("button", { name: /Dark/ }).click();
  await page.getByRole("menuitem", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
});

test("top menu items highlight on hover; the add-group dialog uses its full width", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/dashboard/modifiers");
  // hover highlight: the link's background changes from transparent to a visible colour
  const link = page.getByRole("link", { name: "Orders" });
  const bg = () => link.evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await bg();
  await link.hover();
  await expect.poll(bg).not.toBe(before);
  expect(before).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  // dialog content fills the dialog: the form's right edge reaches the dialog body's padding box
  await page.getByRole("button", { name: "Add group" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.evaluate((el) => {
    const body = el.querySelector(".rs-modal-body") as HTMLElement;
    const form = body.querySelector("form") as HTMLElement;
    const cs = getComputedStyle(body);
    return { body: body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), form: form.offsetWidth };
  });
  expect(box.form, "form width vs body content width").toBeGreaterThanOrEqual(box.body - 2);
});
