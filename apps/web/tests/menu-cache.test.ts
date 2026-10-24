import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { cachedAgentMenu, clearMenuCache, invalidateMenu } from "../src/lib/menu-cache";

type Menu = Awaited<ReturnType<typeof import("../src/lib/modifiers")["availableMenuWithModifiers"]>>;
const menu = (tag: string) => [{ id: tag, name: tag }] as unknown as Menu;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  clearMenuCache();
  process.env.MENU_CACHE_SECONDS = "10";
});

test("repeated calls within the TTL share one query; restaurants never share entries", async () => {
  let calls = 0;
  const load = async (id: string) => (calls++, menu(id));
  const a1 = await cachedAgentMenu("A", load);
  const a2 = await cachedAgentMenu("A", load);
  const b = await cachedAgentMenu("B", load);
  assert.equal(calls, 2);
  assert.equal(a1, a2);
  assert.notDeepEqual(a1, b);
});

test("a burst of simultaneous calls is ONE query", async () => {
  let calls = 0;
  const load = async (id: string) => (calls++, await sleep(30), menu(id));
  const results = await Promise.all(Array.from({ length: 50 }, () => cachedAgentMenu("A", load)));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r === results[0]));
});

test("invalidating (a menu edit) forces the next call to read fresh data", async () => {
  let version = 1;
  const load = async () => menu(`v${version}`);
  assert.equal((await cachedAgentMenu("A", load))[0].id, "v1");
  version = 2;
  assert.equal((await cachedAgentMenu("A", load))[0].id, "v1"); // still cached
  invalidateMenu("A");
  assert.equal((await cachedAgentMenu("A", load))[0].id, "v2");
});

test("entries expire after MENU_CACHE_SECONDS; 0 turns the cache off", async () => {
  process.env.MENU_CACHE_SECONDS = "0.05";
  let calls = 0;
  const load = async () => (calls++, menu("x"));
  await cachedAgentMenu("A", load);
  await sleep(80);
  await cachedAgentMenu("A", load);
  assert.equal(calls, 2);
  process.env.MENU_CACHE_SECONDS = "0";
  await cachedAgentMenu("A", load);
  await cachedAgentMenu("A", load);
  assert.equal(calls, 4);
});

test("a failed load is never cached", async () => {
  let n = 0;
  const load = async () => {
    if (n++ === 0) throw new Error("db down");
    return menu("ok");
  };
  await assert.rejects(cachedAgentMenu("A", load), /db down/);
  assert.equal((await cachedAgentMenu("A", load))[0].id, "ok");
});
