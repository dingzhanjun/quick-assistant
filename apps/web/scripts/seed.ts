// Seeds a demo restaurant for local testing. Idempotent. Run: pnpm --filter web db:seed
// To also make an existing user the owner of Demo Pizza (so it shows in their dashboard):
//   DEMO_OWNER_EMAIL=you@example.com pnpm --filter web db:seed   (sign up first)
import { config } from "dotenv";
config({ path: "../../.env" });

import { and, eq } from "drizzle-orm";

const DEMO_ID = "demo-tenant";
const DEMO_NUMBER = process.env.DEMO_PHONE_NUMBER ?? "+14155550100";

async function main() {
  const { db } = await import("../src/db");
  const {
    member,
    menuItemModifierGroups,
    menuItems,
    modifierGroups,
    modifierOptions,
    organization,
    phoneNumbers,
    user,
  } = await import("../src/db/schema");

  await db
    .insert(organization)
    .values({ id: DEMO_ID, name: "Demo Pizza", slug: "demo-pizza", createdAt: new Date() })
    .onConflictDoNothing();
  // One agent number per restaurant: only give the demo restaurant its demo number if it has none yet.
  const hasNumber = await db.select().from(phoneNumbers).where(eq(phoneNumbers.tenantId, DEMO_ID));
  if (!hasNumber.length) {
    await db.insert(phoneNumbers).values({ e164: DEMO_NUMBER, tenantId: DEMO_ID }).onConflictDoNothing();
  }

  const existing = await db.select().from(menuItems).where(eq(menuItems.tenantId, DEMO_ID));
  if (!existing.length) {
    await db.insert(menuItems).values([
      { tenantId: DEMO_ID, name: "Margherita Pizza", description: "Tomato, mozzarella, basil. 12 inch.", priceCents: 1400 },
      { tenantId: DEMO_ID, name: "Pepperoni Pizza", description: "Pepperoni, mozzarella. 12 inch.", priceCents: 1600 },
      { tenantId: DEMO_ID, name: "Caesar Salad", description: "Contains anchovies and dairy.", priceCents: 900 },
      { tenantId: DEMO_ID, name: "Garlic Knots", description: "Six pieces, contains gluten.", priceCents: 600 },
      { tenantId: DEMO_ID, name: "Cola", priceCents: 300 },
    ]);
  }
  // Modifiers: reusable groups attached to menu items. Each group is created once, by name.
  const existingGroups = await db.select().from(modifierGroups).where(eq(modifierGroups.tenantId, DEMO_ID));
  {
    const items = await db.select().from(menuItems).where(eq(menuItems.tenantId, DEMO_ID));
    const idOf = (name: string) => items.find((i) => i.name === name)?.id;
    const defs = [
      {
        name: "Crust", required: true, maxSelect: 1,
        options: [["Thin", 0], ["Regular", 0], ["Thick", 0]] as [string, number][],
        items: ["Margherita Pizza", "Pepperoni Pizza"],
      },
      {
        name: "Extra toppings", required: false, maxSelect: 3,
        options: [["Extra cheese", 150], ["Mushrooms", 100], ["Olives", 100], ["Extra pepperoni", 200]] as [string, number][],
        items: ["Margherita Pizza", "Pepperoni Pizza"],
      },
      {
        name: "Dipping sauce", required: false, maxSelect: 1,
        options: [["Marinara", 0], ["Garlic butter", 0], ["Ranch", 50]] as [string, number][],
        items: ["Garlic Knots"],
      },
      {
        name: "Size", required: true, maxSelect: 1,
        options: [["Small", 0], ["Large", 200]] as [string, number][],
        items: ["Caesar Salad"],
      },
      {
        name: "Ice", required: false, maxSelect: 1,
        options: [["Regular ice", 0], ["Light ice", 0], ["No ice", 0]] as [string, number][],
        items: ["Cola"],
      },
    ];
    for (const [sortOrder, d] of defs.entries()) {
      if (existingGroups.some((g) => g.name === d.name)) continue;
      const [g] = await db
        .insert(modifierGroups)
        .values({ tenantId: DEMO_ID, name: d.name, required: d.required, maxSelect: d.maxSelect, sortOrder })
        .returning();
      await db.insert(modifierOptions).values(
        d.options.map(([name, priceDeltaCents], i) => ({
          tenantId: DEMO_ID, groupId: g.id, name, priceDeltaCents, sortOrder: i,
        })),
      );
      for (const itemName of d.items) {
        const menuItemId = idOf(itemName);
        if (menuItemId) await db.insert(menuItemModifierGroups).values({ menuItemId, groupId: g.id, sortOrder });
      }
    }
  }
  const [agentLine] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.tenantId, DEMO_ID));
  console.log(`Seeded Demo Pizza, agent number ${agentLine?.e164 ?? "(none)"}`);

  const ownerEmail = process.env.DEMO_OWNER_EMAIL?.trim().toLowerCase();
  if (ownerEmail) {
    const [u] = await db.select().from(user).where(eq(user.email, ownerEmail));
    if (!u) {
      console.log(`No user with email ${ownerEmail}. Sign up first, then re-run.`);
    } else {
      const [existing] = await db
        .select()
        .from(member)
        .where(and(eq(member.organizationId, DEMO_ID), eq(member.userId, u.id)));
      if (!existing) {
        await db.insert(member).values({
          id: crypto.randomUUID(),
          organizationId: DEMO_ID,
          userId: u.id,
          role: "owner",
          createdAt: new Date(),
        });
      }
      console.log(`${ownerEmail} is an owner of Demo Pizza.`);
    }
  }
  process.exit(0);
}
main();
