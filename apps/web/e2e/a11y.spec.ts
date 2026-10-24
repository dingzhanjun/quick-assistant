import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, state } from "./helpers";

// Accessibility + console scan of every page, light and dark (UI_MIGRATION_PLAN.md phase 7). Not part of the normal run:
//   A11Y=1 pnpm test:e2e e2e/a11y.spec.ts
// Fails on serious / critical axe violations and on browser console errors (React / hydration warnings included).
test.skip(!process.env.A11Y, "set A11Y=1 to run the accessibility scan");
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.82.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

const OWNER_PAGES = ["/dashboard", "/dashboard/orders", "/dashboard/menu", "/dashboard/modifiers", "/dashboard/settings", "/dashboard/settings/notifications", "/dashboard/settings/team", "/dashboard/settings/printing"];
const ADMIN_PAGES = ["/admin", "/admin/audit", "/admin/printing"];

async function scan(page: Page, url: string, scheme: string, problems: string[], logs: string[]) {
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => {}); // (the orders board keeps a live connection open: fine)
  await page.waitForTimeout(800);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  for (const v of r.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
    problems.push(`[${scheme}] ${url}: ${v.id} (${v.impact}) ${v.help} -> ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} [${(n.any[0]?.message ?? "").slice(0, 200)}]`).join(" | ")}`);
  }
  void logs;
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: owner pages are accessible and console-clean`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme });
    const logs: string[] = [];
    page.on("console", (m) => m.type() === "error" && logs.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message.slice(0, 300)}`));
    const s = state();
    const problems: string[] = [];
    await page.goto("/");
    await scan(page, "/", scheme, problems, logs);
    await signIn(page, "owner");
    await page.request.post("/api/agent/orders", {
      headers: { authorization: `Bearer ${s.agentKey}` },
      data: { to: s.number, customer_name: "A11y", idempotency_key: `a11y-${scheme}-${s.run}`, items: [{ item_id: s.dishId, quantity: 1 }] },
    });
    for (const url of OWNER_PAGES) await scan(page, url, scheme, problems, logs);
    console.log(`[${scheme}] owner pages: ${problems.length} problem(s), ${logs.length} console error(s)\n${problems.join("\n")}\n${logs.join("\n")}`);
    expect(problems, problems.join("\n")).toEqual([]);
    expect(logs, logs.join("\n")).toEqual([]);
  });

  test(`${scheme}: admin pages are accessible and console-clean`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    const logs: string[] = [];
    page.on("console", (m) => m.type() === "error" && logs.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message.slice(0, 300)}`));
    await context.addCookies([{ name: "better-auth.session_token", value: state().adminCookie, url: "http://localhost:3100" }]);
    const problems: string[] = [];
    for (const url of ADMIN_PAGES) await scan(page, url, scheme, problems, logs);
    console.log(`[${scheme}] admin pages: ${problems.length} problem(s), ${logs.length} console error(s)\n${problems.join("\n")}\n${logs.join("\n")}`);
    expect(problems, problems.join("\n")).toEqual([]);
    expect(logs, logs.join("\n")).toEqual([]);
  });
}
