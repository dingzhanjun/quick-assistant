import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPickup, localTimeToday, resolvePickup, toLocalHHMM } from "../src/lib/pickup";
import type { OpeningHours } from "../src/lib/hours";

const NY = "America/New_York";
// 2026-10-19 (Monday) 16:00 UTC = 12:00 noon in New York (UTC-4)
const NOW = new Date("2026-10-19T16:00:00Z");

test("a time of day today resolves in the restaurant's time zone", () => {
  assert.equal(localTimeToday("18:30", NY, NOW).toISOString(), "2026-10-19T22:30:00.000Z");
  assert.equal(toLocalHHMM(new Date("2026-10-19T22:30:00Z"), NY), "18:30");
  assert.equal(formatPickup(new Date("2026-10-19T22:30:00Z"), NY), "6:30 PM");
  assert.equal(formatPickup(null, NY), "ASAP");
  // Los Angeles is 3 hours behind New York
  assert.equal(localTimeToday("18:30", "America/Los_Angeles", NOW).toISOString(), "2026-10-20T01:30:00.000Z");
});

test("daylight saving change days are handled", () => {
  // 2026-11-01 is the US fall-back day: 18:00 local is UTC-5 afterwards
  assert.equal(localTimeToday("18:00", NY, new Date("2026-11-01T17:00:00Z")).toISOString(), "2026-11-01T23:00:00.000Z");
});

test("times in the past are refused, near-now and future times are accepted", () => {
  assert.deepEqual(resolvePickup("11:00", NY, null, NOW), { ok: false, code: "past" });
  assert.equal(resolvePickup("11:59", NY, null, NOW).ok, true); // within 2 minutes of slack
  assert.equal(resolvePickup("12:30", NY, null, NOW).ok, true);
});

test("a time outside opening hours is refused, with the hours to tell the caller", () => {
  const hours: OpeningHours = { mon: [["11:00", "22:00"]] };
  assert.equal(resolvePickup("20:00", NY, hours, NOW).ok, true);
  const late = resolvePickup("23:00", NY, hours, NOW);
  assert.equal(late.ok, false);
  assert.match((late as { hours: string }).hours, /Monday 11 AM to 10 PM/);
});
