import { describeHours, isOpenAt, type OpeningHours } from "./hours";

// Pickup time for a phone order: "asap" (stored as null) or a time of day TODAY in the restaurant's time zone.
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Offset (ms) of `tz` from UTC at the instant `at`: local wall clock minus UTC.
function tzOffsetMs(at: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - at.getTime();
}

// Today's calendar date in `tz`, and the UTC instant of HH:MM on that date.
export function localTimeToday(time: string, tz: string, now: Date): Date {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); // YYYY-MM-DD
  const [y, m, day] = d.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, day, h, mi);
  let at = new Date(wall - tzOffsetMs(new Date(wall), tz));
  at = new Date(wall - tzOffsetMs(at, tz)); // second pass settles the DST edge
  return at;
}

export type PickupResult =
  | { ok: true; at: Date }
  | { ok: false; code: "past" | "closed"; hours?: string };

// A pickup time must still be ahead (2 minutes of slack for a caller who says "now-ish"), and, when the restaurant
// has opening hours, fall inside them.
export function resolvePickup(
  time: string,
  tz: string,
  hours: OpeningHours | null,
  now: Date = new Date(),
): PickupResult {
  const at = localTimeToday(time, tz, now);
  if (at.getTime() < now.getTime() - 2 * 60_000) return { ok: false, code: "past" };
  if (hours && !isOpenAt(hours, tz, at)) return { ok: false, code: "closed", hours: describeHours(hours) };
  return { ok: true, at };
}

// "ASAP" or "6:30 PM" (the restaurant's time zone), for emails and the dashboard.
export function formatPickup(at: Date | null, tz: string): string {
  if (!at) return "ASAP";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
}

// "HH:MM" of an instant in `tz` (used to hand an existing order's pickup back to the agent).
export function toLocalHHMM(at: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return p;
}

// The pickup time that counts: the restaurant's new time if it moved the pickup, else what the customer asked for
// (null = as soon as possible).
export const effectivePickup = (o: { pickupAt: Date | null; newPickupAt?: Date | null }): Date | null => o.newPickupAt ?? o.pickupAt;
