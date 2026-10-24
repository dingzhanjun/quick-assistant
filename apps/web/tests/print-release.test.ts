// Where the print agent's downloads live: files built into the web image, or an explicit override (lib/print/release.ts).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentRelease } from "../src/lib/print/release";

const site = { BETTER_AUTH_URL: "https://orders.example.com/" };
const dirWith = (files: Record<string, string>) => {
  const d = mkdtempSync(path.join(tmpdir(), "rel-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(d, n), c);
  return d;
};
const full = { VERSION: "0.1.0\n", "order-printer-linux-arm64": "bin", "order-printer-linux-arm64.sha256": "abc  order-printer-linux-arm64\n" };

test("files built into the image: the server hosts its own downloads at /printer", () => {
  assert.deepEqual(agentRelease({ env: site, dir: dirWith(full) }), { version: "0.1.0", baseUrl: "https://orders.example.com/printer" });
});

test("an explicit PRINT_AGENT_VERSION + PRINT_AGENT_BASE_URL override wins (a release hosted elsewhere)", () => {
  const env = { ...site, PRINT_AGENT_VERSION: "2.0.0", PRINT_AGENT_BASE_URL: "https://cdn.example.com/agent/" };
  assert.deepEqual(agentRelease({ env, dir: dirWith(full) }), { version: "2.0.0", baseUrl: "https://cdn.example.com/agent" });
  // only one of the two set: not an override, the built-in files are used
  assert.equal(agentRelease({ env: { ...site, PRINT_AGENT_VERSION: "2.0.0" }, dir: dirWith(full) })?.version, "0.1.0");
});

test("no agent files (a dev build), a broken VERSION, or missing binaries: no release", () => {
  assert.equal(agentRelease({ env: site, dir: path.join(tmpdir(), "does-not-exist") }), null);
  assert.equal(agentRelease({ env: site, dir: dirWith({ ...full, VERSION: "latest" }) }), null);
  assert.equal(agentRelease({ env: site, dir: dirWith({ VERSION: "0.1.0" }) }), null, "VERSION without the binary");
  assert.equal(agentRelease({ env: site, dir: dirWith({ VERSION: "0.1.0", "order-printer-linux-arm64": "bin" }) }), null, "binary without its checksum");
  assert.equal(agentRelease({ env: {}, dir: dirWith(full) }), null, "no site address to build the URL from");
});
