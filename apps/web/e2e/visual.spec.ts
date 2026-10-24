import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, state } from "./helpers";

// Visual baseline for the UI-library migration (UI_MIGRATION_PLAN.md). NOT a pass/fail test: it only saves screenshots of
// every page, at desktop and phone width, so before / after can be compared by eye.
//   VISUAL_LABEL=name [VISUAL_SCHEME=dark] pnpm test:e2e e2e/visual.spec.ts   ->  e2e/screenshots/name/*.png
// Skipped unless VISUAL_LABEL is set, so the normal e2e run is unaffected.
const LABEL = process.env.VISUAL_LABEL;
test.skip(!LABEL, "set VISUAL_LABEL to capture screenshots");
test.describe.configure({ mode: "serial" });
// own client address: sign-ins are rate limited per IP
// VISUAL_SCHEME=dark captures with the browser in dark mode (next-themes follows the system setting)
test.use({ colorScheme: process.env.VISUAL_SCHEME === "dark" ? "dark" : "light" });
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

const SIZES = [{ w: 1280, h: 900 }, { w: 768, h: 1000 }, { w: 375, h: 800 }];
const dir = path.join(__dirname, "screenshots", LABEL ?? "x");

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400); // let transitions and live connections settle
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  test(`owner pages at ${size.w}px`, async ({ page }) => {
    test.setTimeout(120_000);
    fs.mkdirSync(dir, { recursive: true });
    const s = state();
    await page.setViewportSize({ width: size.w, height: size.h });
    const suffix = `-${size.w}`;

    // public pages
    await page.goto("/");
    await shot(page, `01-sign-in${suffix}`);
    await page.getByRole("button", { name: /create account|sign up/i }).first().click().catch(() => {});
    await shot(page, `02-sign-up${suffix}`);
    await page.goto("/forgot-password");
    await shot(page, `03-forgot-password${suffix}`);

    await signIn(page, "owner");
    // an order so the board is not empty
    await page.request.post("/api/agent/orders", {
      headers: { authorization: `Bearer ${s.agentKey}` },
      data: { to: s.number, customer_name: `Visual ${size.w}`, idempotency_key: `visual-${LABEL}-${size.w}-${s.run}`, items: [{ item_id: s.dishId, quantity: 2, notes: "extra napkins" }] },
    });
    for (const [name, url] of [
      ["10-overview", "/dashboard"], ["11-orders", "/dashboard/orders"], ["12-menu", "/dashboard/menu"], ["13-modifiers", "/dashboard/modifiers"],
      ["14-settings-general", "/dashboard/settings"], ["15-settings-team", "/dashboard/settings/team"], ["15b-settings-notifications", "/dashboard/settings/notifications"], ["16-settings-printing", "/dashboard/settings/printing"],
    ] as const) {
      await page.goto(url);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, `${name}${suffix}`);
    }

    // opening hours with the time pickers open, and an open picker menu (audit filters are on the admin pages below)
    await page.goto("/dashboard/settings");
    await page.waitForLoadState("networkidle").catch(() => {}); // a streamed page briefly holds a hidden duplicate of its content
    await page.getByLabel("Only answer during opening hours").first().check({ force: true });
    await page.getByLabel("Monday").check({ force: true });
    await shot(page, `14b-settings-hours${suffix}`);
    await page.getByRole("combobox", { name: "Monday opens" }).click({ timeout: 4000 }).catch(() => {});
    await shot(page, `14c-time-picker-open${suffix}`);
    await page.keyboard.press("Escape");

    // overlays: the dish editor dialog, the confirmation dialog, and the printing "setup files" panel
    await page.goto("/dashboard/menu");
    await page.getByRole("button", { name: "Add item" }).click();
    await shot(page, `20-dialog-add-item${suffix}`);
    await page.keyboard.press("Escape");
    await page.goto("/dashboard/modifiers");
    await page.getByRole("button", { name: "Add group" }).click();
    await shot(page, `20b-dialog-add-group${suffix}`);
    await page.keyboard.press("Escape");
    await page.goto("/dashboard/orders");
    await page.getByRole("button", { name: "Cancel" }).first().click();
    await shot(page, `21-confirm-cancel-order${suffix}`);
    await page.keyboard.press("Escape");
    await page.goto("/dashboard/settings/printing");
    await page.getByText("Set up a new Pi without a monitor").first().click();
    await shot(page, `22-printing-setup-files${suffix}`);
  });

  test(`admin pages at ${size.w}px`, async ({ page, context }) => {
    fs.mkdirSync(dir, { recursive: true });
    const s = state();
    await page.setViewportSize({ width: size.w, height: size.h });
    await context.addCookies([{ name: "better-auth.session_token", value: s.adminCookie, url: "http://localhost:3100" }]);
    for (const [name, url] of [["30-admin", "/admin"], ["31-admin-audit", "/admin/audit"], ["32-admin-printing", "/admin/printing"]] as const) {
      await page.goto(url);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, `${name}-${size.w}`);
    }
    await page.goto("/admin/audit");
    await page.getByRole("combobox", { name: "Action" }).click();
    await shot(page, `33-audit-select-open-${size.w}`);
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "From date" }).click({ timeout: 4000 }).catch(() => {});
    await shot(page, `34-audit-date-open-${size.w}`);
    expect(true).toBe(true);
  });
}
