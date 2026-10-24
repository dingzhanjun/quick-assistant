import postgres from "postgres";
import { expect, test } from "./fixtures";
import { signIn, state } from "./helpers";

// Sign-ins are limited to 10/min per IP: this spec has its own address (see print.spec.ts).
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.89.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

test("an owner of two restaurants copies the menu of one into the other", async ({ page }) => {
  const s = state();
  const sql = postgres(process.env.DATABASE_URL!);
  const other = `e2e-second-${s.run}`;
  try {
    // a second restaurant for the same owner, with a one-dish menu in a category
    const [u] = await sql`select id from "user" where email = ${s.owner.email}`;
    await sql`insert into organization (id, name, slug, created_at) values (${other}, ${`Second Location ${s.run}`}, ${other}, now())`;
    await sql`insert into member (id, organization_id, user_id, role, created_at) values (${`m-${other}`}, ${other}, ${u.id}, 'owner', now())`;
    const [cat] = await sql`insert into categories (tenant_id, name) values (${other}, ${`Noodles ${s.run}`}) returning id`;
    const [dish] = await sql`insert into menu_items (tenant_id, name, price_cents) values (${other}, ${`Lo Mein ${s.run}`}, 1250) returning id`;
    await sql`insert into menu_item_categories (menu_item_id, category_id) values (${dish.id}, ${cat.id})`;

    await signIn(page, "owner");
    await page.goto("/dashboard/menu");
    await page.getByRole("button", { name: "Copy from another restaurant" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`Second Location ${s.run}`).first()).toBeVisible();
    await expect(dialog.getByText("1", { exact: true }).first()).toBeVisible(); // "1 new dishes"
    await expect(dialog.getByText(`New categories: Noodles ${s.run}`)).toBeVisible();
    await dialog.getByRole("button", { name: "Copy menu" }).click();
    await expect(page.getByText(/Menu copied: 1 dishes added/)).toBeVisible();

    await expect(page.getByText(`Lo Mein ${s.run}`, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: `Noodles ${s.run}` })).toBeVisible();

    // copying again: nothing left to copy
    await page.getByRole("button", { name: "Copy from another restaurant" }).click();
    await expect(page.getByRole("dialog").getByText("Nothing to copy")).toBeVisible();
  } finally {
    // tidy up: the copied dish and category here, the second restaurant (cascades its menu and membership)
    await sql`delete from menu_items where tenant_id = (select id from organization where name like ${`E2E Diner ${s.run}`}) and name = ${`Lo Mein ${s.run}`}`;
    await sql`delete from categories where name = ${`Noodles ${s.run}`}`;
    await sql`delete from organization where id = ${other}`;
    await sql.end();
  }
});
