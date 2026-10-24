import { lineUnitCents } from "../pricing";

// Structured kitchen ticket (client-safe: also drives the dashboard preview). The PNG the printer gets is rendered
// from this by render.ts.
export type TicketKind = "new" | "changed" | "cancelled" | "reprint" | "test";

export type TicketLine = {
  quantity: number;
  name: string;
  options: string[];
  notes?: string;
  // Price of the whole line (quantity x (base + options)); absent on tickets stored before prices were printed.
  lineCents?: number;
};

export type Ticket = {
  kind: TicketKind;
  restaurant: string;
  orderNumber: number | null;
  // "ASAP" or a clock time in the restaurant's time zone, e.g. "6:30 PM".
  pickup: string;
  customerName?: string;
  placedAt: string;
  lines: TicketLine[];
  totalCents: number;
  // For `changed`: the order this one replaces.
  replaces?: number;
};

// "10/21/2026 6:30 PM" in the restaurant's time zone.
export function formatDateTime(at: Date, timezone: string): string {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "2-digit", day: "2-digit", year: "numeric" }).format(at);
  return `${d} ${formatClock(at, timezone)}`;
}

export function formatClock(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(at);
}

type OrderInput = {
  orderNumber: number;
  customerName: string | null;
  pickupAt: Date | null;
  newPickupAt?: Date | null; // the restaurant's changed pickup time: it counts when set
  createdAt: Date;
  items: {
    name: string;
    priceCents: number;
    quantity: number;
    notes: string | null;
    modifiers: { option: string; priceDeltaCents: number }[];
  }[];
};

export function buildTicket(opts: {
  kind: Exclude<TicketKind, "test">;
  restaurant: string;
  timezone: string;
  order: OrderInput;
  replaces?: number;
}): Ticket {
  const { order } = opts;
  return {
    kind: opts.kind,
    restaurant: opts.restaurant,
    orderNumber: order.orderNumber,
    pickup: (order.newPickupAt ?? order.pickupAt) ? formatClock((order.newPickupAt ?? order.pickupAt)!, opts.timezone) : "ASAP",
    customerName: order.customerName ?? undefined,
    placedAt: formatDateTime(order.createdAt, opts.timezone),
    lines: order.items.map((i) => ({
      quantity: i.quantity,
      name: i.name,
      options: i.modifiers.map((m) => m.option),
      ...(i.notes ? { notes: i.notes } : {}),
      lineCents: lineUnitCents(i.priceCents, i.modifiers) * i.quantity,
    })),
    totalCents: order.items.reduce((s, i) => s + lineUnitCents(i.priceCents, i.modifiers) * i.quantity, 0),
    ...(opts.replaces ? { replaces: opts.replaces } : {}),
  };
}

export function testTicket(restaurant: string, timezone: string, now = new Date()): Ticket {
  return {
    kind: "test", restaurant, orderNumber: null, pickup: "ASAP", placedAt: formatDateTime(now, timezone),
    lines: [{ quantity: 1, name: "Test print", options: [], notes: "If you can read this, printing works." }],
    totalCents: 0,
  };
}
