// Opening hours (LAUNCH_PLAN D7): when a restaurant is closed the agent says the hours and hangs up.
// Stored in tenant_settings.opening_hours as { mon: [["11:00","22:00"]], ... }; a missing/empty day is closed.
// `null` hours = no schedule configured = always open. Kept DB-free so client components can import it.
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];
export type OpeningHours = Partial<Record<Day, [string, string][]>>;

const DAY_NAMES: Record<Day, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validHours(h: unknown): h is OpeningHours {
  if (!h || typeof h !== "object") return false;
  return Object.entries(h).every(
    ([d, ranges]) =>
      (DAYS as readonly string[]).includes(d) &&
      Array.isArray(ranges) &&
      ranges.length <= 4 &&
      ranges.every((r) => Array.isArray(r) && r.length === 2 && TIME.test(r[0]) && TIME.test(r[1]) && r[0] !== r[1]),
  );
}

// Day of week and minutes since midnight in the restaurant's time zone.
function localParts(now: Date, tz: string): { day: Day; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = get("weekday").slice(0, 3).toLowerCase() as Day;
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isOpenAt(hours: OpeningHours | null, tz: string, now: Date = new Date()): boolean {
  if (!hours) return true;
  const { day, minutes } = localParts(now, tz);
  const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
  for (const [open, close] of hours[day] ?? []) {
    const o = toMin(open), c = toMin(close);
    if (c > o ? minutes >= o && minutes < c : minutes >= o) return true; // close <= open: runs past midnight
  }
  for (const [open, close] of hours[prev] ?? []) {
    if (toMin(close) <= toMin(open) && minutes < toMin(close)) return true; // spill-over from yesterday
  }
  return false;
}

function clock(t: string): string {
  const h = Number(t.slice(0, 2)), m = t.slice(3);
  return `${h % 12 || 12}${m === "00" ? "" : ":" + m} ${h < 12 ? "AM" : "PM"}`;
}

// Spoken/readable summary, e.g. "Monday to Friday 11 AM to 10 PM, Saturday 12 PM to 11 PM".
export function describeHours(hours: OpeningHours): string {
  const lines: { label: string; text: string }[] = [];
  for (const d of DAYS) {
    const text = (hours[d] ?? []).map(([o, c]) => `${clock(o)} to ${clock(c)}`).join(" and ");
    if (!text) continue;
    const last = lines[lines.length - 1];
    if (last && last.text === text && last.label.endsWith(DAY_NAMES[DAYS[DAYS.indexOf(d) - 1]])) {
      last.label = last.label.replace(/ to .*$/, "") + " to " + DAY_NAMES[d];
    } else lines.push({ label: DAY_NAMES[d], text });
  }
  return lines.map((l) => `${l.label} ${l.text}`).join(", ") || "closed every day";
}
