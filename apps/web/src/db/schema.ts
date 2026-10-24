import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  jsonb,
  primaryKey,
  index,
  integer,
  pgTable,
  uniqueIndex,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { OpeningHours } from "../lib/hours";
import { organization } from "./auth-schema";

export * from "./auth-schema";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// Every table below is scoped to a tenant (= Better Auth organization).
const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

// Single-row (id = 'default') platform config, managed only from /admin.
// API keys are NOT stored here; they live in the agent's environment.
export const platformSettings = pgTable("platform_settings", {
  id: text("id").primaryKey().default("default"),
  llmProvider: text("llm_provider", { enum: ["openai", "deepseek"] })
    .default("openai")
    .notNull(),
  llmModel: text("llm_model").default("gpt-4o-mini").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Per-tenant settings. `suspended` is platform-controlled (/admin only); the notify_* columns
// are controlled by the restaurant (/dashboard/settings).
export const tenantSettings = pgTable("tenant_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  suspended: boolean("suspended").default(false).notNull(),
  // Human line (E.164) a caller is forwarded to on keypad 0 / "human agent". Platform-admin controlled; null = none.
  transferNumber: text("transfer_number"),
  // Comma-separated recipients for new-order emails; null = the restaurant's owners.
  notifyEmails: text("notify_emails"),
  notifyNewOrders: boolean("notify_new_orders").default(true).notNull(),
  // Street address the phone agent can give when asked. Restaurant-controlled.
  address: text("address"),
  // Opening hours (restaurant-controlled): IANA time zone + weekly schedule, see src/lib/hours.ts.
  // null hours = no schedule = always open.
  timezone: text("timezone").default("America/New_York").notNull(),
  openingHours: jsonb("opening_hours").$type<OpeningHours>(),
  // Kitchen printing (restaurant-controlled): print every new order at once, or only when staff accept it.
  printTiming: text("print_timing", { enum: ["immediate", "on_accept"] }).default("immediate").notNull(),
  // Offer callers a text message with a link to their order (restaurant-controlled; also needs SMS_PROVIDER on the server).
  textOrderLink: boolean("text_order_link").default(true).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Dialed number -> tenant. Entry point for resolving a call to a restaurant.
export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    e164: text("e164").primaryKey(),
    tenantId: tenantId(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  // Each restaurant has exactly one agent phone number (a number also belongs to only one restaurant: the PK).
  (t) => [uniqueIndex("phone_numbers_tenant_idx").on(t.tenantId)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    available: boolean("available").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("menu_items_tenant_idx").on(t.tenantId)],
);

// Modifiers: reusable option groups (e.g. "Spice level", "Extras") that can be attached to many menu items.
// `required` = the caller must pick at least one option; `maxSelect` = most options allowed (1 = pick one).
export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    required: boolean("required").default(false).notNull(),
    maxSelect: integer("max_select").default(1).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("modifier_groups_tenant_idx").on(t.tenantId)],
);

export const modifierOptions = pgTable(
  "modifier_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priceDeltaCents: integer("price_delta_cents").default(0).notNull(),
    available: boolean("available").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
  },
  (t) => [index("modifier_options_group_idx").on(t.groupId)],
);

// Which groups apply to which menu items (many-to-many).
export const menuItemModifierGroups = pgTable(
  "menu_item_modifier_groups",
  {
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.menuItemId, t.groupId] })],
);

// Categories ("Drinks", "Vegetarian", ...): per restaurant, and a dish can be in several (many-to-many, like modifiers).
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("categories_tenant_idx").on(t.tenantId)],
);

export const menuItemCategories = pgTable(
  "menu_item_categories",
  {
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.menuItemId, t.categoryId] })],
);

export const modifierGroupsRelations = relations(modifierGroups, ({ many }) => ({
  options: many(modifierOptions),
}));
export const modifierOptionsRelations = relations(modifierOptions, ({ one }) => ({
  group: one(modifierGroups, { fields: [modifierOptions.groupId], references: [modifierGroups.id] }),
}));

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // Human-friendly number, allocated per tenant when the order is created.
    orderNumber: integer("order_number").notNull(),
    customerName: text("customer_name"),
    // Caller's phone number (from SIP) and the agent's idempotency key (call id + cart hash): the same key
    // submitted twice for a tenant returns the existing order instead of creating a duplicate.
    callerNumber: text("caller_number"),
    // The mobile number the customer asked us to text the order link to (may differ from the caller's number).
    // Personal data: cleared with caller_number by the retention job.
    contactNumber: text("contact_number"),
    // Unguessable token in the public order link (/orders/<token>); set when the order is created.
    publicToken: text("public_token"),
    // How many times the customer gave a number to text during the call (at most 2: one correction of the number).
    smsCount: integer("sms_count").default(0).notNull(),
    // When the order-link text was queued: it goes out once, when the restaurant confirms the order (or at once if the
    // customer gives the number after that). Null = not sent (yet).
    smsSentAt: timestamp("sms_sent_at"),
    // When the customer will pick the order up: a time today in the restaurant's time zone; null = as soon as possible.
    pickupAt: timestamp("pickup_at"),
    // "New pickup time": set by the restaurant when it moves the pickup (the customer is texted). When not null it IS the
    // pickup time everywhere (board, ticket, order page); `pickup_at` keeps what the customer originally asked for.
    newPickupAt: timestamp("new_pickup_at"),
    // Set when the "nobody acknowledged this order" alert was sent, so it is sent only once.
    unackAlertedAt: timestamp("unack_alerted_at"),
    idempotencyKey: text("idempotency_key"),
    status: text("status", {
      enum: ["new", "preparing", "ready", "completed", "cancelled"],
    })
      .default("new")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("orders_tenant_idx").on(t.tenantId, t.createdAt),
    uniqueIndex("orders_tenant_number_idx").on(t.tenantId, t.orderNumber),
    uniqueIndex("orders_tenant_idem_idx").on(t.tenantId, t.idempotencyKey),
    uniqueIndex("orders_public_token_idx").on(t.publicToken),
    index("orders_contact_idx").on(t.contactNumber, t.createdAt),
  ],
);

// One row per inbound call, written by /api/agent/calls. Drives the per-caller rate limit and the
// per-restaurant concurrency limit. Caller numbers are personal data: purge rows past the retention period.
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // LiveKit room name; makes the start request idempotent if the worker retries.
    callId: text("call_id").notNull(),
    callerNumber: text("caller_number"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    uniqueIndex("calls_call_id_idx").on(t.callId),
    index("calls_tenant_started_idx").on(t.tenantId, t.startedAt),
    index("calls_caller_started_idx").on(t.callerNumber, t.startedAt),
  ],
);

// Caller numbers the platform admin refuses to serve on any restaurant.
export const blockedNumbers = pgTable("blocked_numbers", {
  e164: text("e164").primaryKey(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const orderItems = pgTable("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  menuItemId: uuid("menu_item_id").references(() => menuItems.id, { onDelete: "set null" }),
  // Snapshot so later menu edits don't rewrite past orders.
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  // Chosen modifiers, snapshotted like the name/price: [{ group, option, priceDeltaCents }]
  modifiers: jsonb("modifiers")
    .$type<{ group: string; option: string; priceDeltaCents: number; optionId?: string }[]>()
    .default([])
    .notNull(),
  quantity: integer("quantity").notNull(),
  notes: text("notes"),
});

export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

// ---- Kitchen printing (PRINTING_PLAN.md). A print agent is a small program (Raspberry Pi) in the restaurant that polls
// for tickets and prints them. Tokens and pairing codes are stored hashed only.
export const printAgents = pgTable(
  "print_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    tokenHash: text("token_hash"),
    pairingCodeHash: text("pairing_code_hash"),
    pairingExpiresAt: timestamp("pairing_expires_at"),
    version: text("version"),
    lanIp: text("lan_ip"),
    hostname: text("hostname"),
    info: jsonb("info").$type<Record<string, unknown>>(),
    lastSeenAt: timestamp("last_seen_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("print_agents_token_idx").on(t.tokenHash),
    uniqueIndex("print_agents_pairing_idx").on(t.pairingCodeHash),
    index("print_agents_tenant_idx").on(t.tenantId),
  ],
);

// Allow-listed service commands queued for an agent and delivered through its outbound poll (never a shell).
export const printAgentCommands = pgTable(
  "print_agent_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").notNull().references(() => printAgents.id, { onDelete: "cascade" }),
    command: text("command", {
      enum: ["restart-agent", "test-print", "show-log", "update", "redetect-printers", "reboot", "setup-ticket"],
    }).notNull(),
    args: jsonb("args").$type<Record<string, unknown>>(),
    requestedBy: text("requested_by"),
    status: text("status", { enum: ["queued", "sent", "done", "failed", "expired"] }).default("queued").notNull(),
    result: text("result"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("print_agent_commands_agent_idx").on(t.agentId, t.status)],
);

export type PrinterStatus = { online?: boolean; paperOut?: boolean; coverOpen?: boolean; error?: string };
export const printers = pgTable(
  "printers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: uuid("agent_id").references(() => printAgents.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // What the agent calls the device, e.g. "lp0".
    deviceKey: text("device_key"),
    paperWidthMm: integer("paper_width_mm").default(80).notNull(),
    copies: integer("copies").default(1).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    lastStatus: jsonb("last_status").$type<PrinterStatus>(),
    lastStatusAt: timestamp("last_status_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("printers_tenant_idx").on(t.tenantId)],
);

// One ticket for one printer. `ticket` (structured JSON) drives the dashboard preview; `image` is the 1-bit PNG the
// agent prints. Both are purged after 30 days. `dedupe_key` makes a retry or double trigger a no-op.
export const printJobs = pgTable(
  "print_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    printerId: uuid("printer_id").notNull().references(() => printers.id, { onDelete: "cascade" }),
    // An order is never deleted by the app; if it ever is, the ticket history stays.
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["new", "changed", "cancelled", "reprint", "test"] }).notNull(),
    status: text("status", { enum: ["pending", "leased", "done", "failed"] }).default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leasedUntil: timestamp("leased_until"),
    ticket: jsonb("ticket").$type<import("../lib/print/ticket").Ticket>().notNull(),
    image: bytea("image").notNull(),
    error: text("error"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    printedAt: timestamp("printed_at"),
  },
  (t) => [
    uniqueIndex("print_jobs_dedupe_idx").on(t.dedupeKey),
    index("print_jobs_queue_idx").on(t.printerId, t.status, t.createdAt),
    index("print_jobs_order_idx").on(t.orderId),
  ],
);

// Append-only record of who did what (viewed by the platform admin at /admin/audit). Rows are only ever
// inserted by `audit()` in src/lib/audit.ts; nothing in the app updates or deletes them. No foreign keys on
// purpose: the trail must survive deleting a restaurant, user, order or menu item.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // null for platform-level actions (sign-ins, LLM config, blocked callers)
    tenantId: text("tenant_id"),
    actorType: text("actor_type", { enum: ["user", "admin", "agent", "system"] }).notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label"), // email at the time, or "voice agent"
    action: text("action").notNull(), // e.g. "order.created", see src/lib/audit-actions.ts
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    summary: text("summary").notNull(), // one human-readable line
    details: jsonb("details").$type<Record<string, unknown>>(), // before/after, ids, never secrets
  },
  (t) => [
    index("audit_created_idx").on(t.createdAt),
    index("audit_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_action_created_idx").on(t.action, t.createdAt),
  ],
);

// Login/sign-up rate limit counters (Better Auth, `rateLimit.storage: "database"`). In the database instead of
// process memory so every web replica shares one count per client address. Old rows are purged by the job worker.
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// Background jobs with retries (outbound email today). Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of
// web processes can run the worker without sending anything twice. See src/lib/jobs.ts.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: ["email", "sms"] }).notNull(),
    // email: {to, subject, text}; sms: {to, text, orderId}
    payload: jsonb("payload").$type<{ to: string; subject?: string; text: string; tenantId?: string; orderId?: string }>().notNull(),
    status: text("status", { enum: ["pending", "running", "done", "failed"] }).default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    runAt: timestamp("run_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [index("jobs_due_idx").on(t.status, t.runAt)],
);
