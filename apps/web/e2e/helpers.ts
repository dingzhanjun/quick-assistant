import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import { STATE_FILE, type E2EState } from "./global-setup";

export const state = (): E2EState => JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

export async function signIn(page: Page, who: "owner" | "staff") {
  const c = state()[who];
  await page.goto("/");
  await page.getByLabel("Email").fill(c.email);
  await page.getByLabel("Password").fill(c.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("link", { name: "Orders" })).toBeVisible();
}

// What the voice agent would see: the restaurant's menu via the internal API.
export async function agentMenu(page: Page) {
  const s = state();
  const res = await page.request.get(`/api/agent/menu?to=${encodeURIComponent(s.number)}`, {
    headers: { authorization: `Bearer ${s.agentKey}` },
  });
  expect(res.status()).toBe(200);
  return res.json() as Promise<{ name: string; closed?: boolean; address?: string | null; transfer_number?: string | null; items: { id: string; name: string; categories: { name: string }[]; modifierGroups: { name: string; required: boolean; options: { name: string; priceDeltaCents: number }[] }[] }[] }>;
}

// Choose an option in a React Suite SelectPicker (there are no native selects in the app).
export async function pick(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).first().click();
}
