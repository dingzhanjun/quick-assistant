import assert from "node:assert/strict";
import { test } from "node:test";
import { securityHeaders } from "../src/lib/security-headers";

const get = (h: { key: string; value: string }[], k: string) => h.find((x) => x.key === k)?.value;

test("production sends every required security header", () => {
  const h = securityHeaders(false);
  for (const k of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security"]) {
    assert.ok(get(h, k), `missing ${k}`);
  }
  const csp = get(h, "Content-Security-Policy")!;
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});
test("dev allows eval/websockets for hot reload and skips HSTS", () => {
  const h = securityHeaders(true);
  assert.match(get(h, "Content-Security-Policy")!, /unsafe-eval/);
  assert.equal(get(h, "Strict-Transport-Security"), undefined);
});
