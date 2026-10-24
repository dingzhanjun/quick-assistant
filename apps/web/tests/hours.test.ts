import assert from "node:assert/strict";
import { test } from "node:test";
import { describeHours, isOpenAt, validHours, type OpeningHours } from "../src/lib/hours";

const NY = "America/New_York";
const H: OpeningHours = {
  mon: [["11:00", "22:00"]], tue: [["11:00", "22:00"]], wed: [["11:00", "22:00"]],
  fri: [["17:00", "02:00"]], // overnight
};
// 2026-10-19 is a Monday. New York is UTC-4 in October.
const at = (iso: string) => new Date(iso);

test("open and closed within a day, in the restaurant's time zone", () => {
  assert.equal(isOpenAt(H, NY, at("2026-10-19T16:00:00Z")), true); // Mon 12:00 NY
  assert.equal(isOpenAt(H, NY, at("2026-10-19T14:00:00Z")), false); // Mon 10:00 NY
  assert.equal(isOpenAt(H, NY, at("2026-10-19T02:30:00Z")), false); // Sun 22:30 NY: closed day
  assert.equal(isOpenAt(H, NY, at("2026-10-22T16:00:00Z")), false); // Thu: no hours
});
test("overnight range spills into the next day", () => {
  assert.equal(isOpenAt(H, NY, at("2026-10-24T04:00:00Z")), true); // Sat 00:00 NY, Fri's shift
  assert.equal(isOpenAt(H, NY, at("2026-10-24T07:00:00Z")), false); // Sat 03:00 NY
});
test("no schedule means always open", () => {
  assert.equal(isOpenAt(null, NY), true);
});
test("validation and wording", () => {
  assert.equal(validHours(H), true);
  assert.equal(validHours({ mon: [["25:00", "26:00"]] }), false);
  assert.equal(validHours({ xyz: [] }), false);
  assert.equal(describeHours(H), "Monday to Wednesday 11 AM to 10 PM, Friday 5 PM to 2 AM");
});
