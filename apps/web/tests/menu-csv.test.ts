import assert from "node:assert/strict";
import { test } from "node:test";
import { menuToCsv, parseCsv, parseMenuCsv, parsePrice, splitCategories, TEMPLATE_CSV } from "../src/lib/menu-csv";

test("parseCsv handles quotes, commas, line breaks, BOM and blank lines", () => {
  const t = '﻿a,b,c\r\n1,"x, ""y""",3\n\n"multi\nline",,z\r\n';
  assert.deepEqual(parseCsv(t), [["a", "b", "c"], ["1", 'x, "y"', "3"], ["multi\nline", "", "z"]]);
});

test("prices: plain, dollar sign, thousands; rejects junk", () => {
  assert.equal(parsePrice("4"), 400);
  assert.equal(parsePrice(" $4.50 "), 450);
  assert.equal(parsePrice("1,234.5"), 123450);
  for (const bad of ["", "abc", "-1", "4.999", "1e3", "20000"]) assert.equal(parsePrice(bad), null, bad);
});

test("categories split on ; | , and drop empties and duplicates", () => {
  assert.deepEqual(splitCategories("Drinks; Vegetarian | drinks , ,Hot"), ["Drinks", "Vegetarian", "Hot"]);
});

test("a good file parses; absent columns stay undefined, present-but-empty ones are empty", () => {
  const r = parseMenuCsv("Name,Price,Categories\nTea,4,Drinks\nRice,$9.5,\n");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows.map((x) => [x.name, x.priceCents, x.categories, x.description, x.available]), [
    ["Tea", 400, ["Drinks"], undefined, undefined],
    ["Rice", 950, [], undefined, undefined],
  ]);
});

test("row errors name the line and do not stop the other rows being checked", () => {
  const r = parseMenuCsv("name,price,available\nTea,4,maybe\n,3,yes\nRice,x,yes\nTea,5,yes\nOk,1,no\nok,2,no\n");
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4, 5, 7]);
  assert.match(r.errors[0].message, /yes or no/);
  assert.match(r.errors[3].message, /appears twice/); // the second Tea (line 5), whatever the first one's own problem
  assert.deepEqual(r.rows.map((x) => x.name), ["Ok"]);
});

test("header problems: missing required columns, unknown columns, empty file, too many rows", () => {
  assert.match(parseMenuCsv("name\nTea\n").errors[0].message, /name, price/);
  assert.match(parseMenuCsv("name,price,colour\nTea,4,red\n").errors[0].message, /Unknown column/);
  assert.match(parseMenuCsv("").errors[0].message, /empty/);
  assert.match(parseMenuCsv("name,price\n").errors[0].message, /no dishes/);
  const big = `name,price\n${Array.from({ length: 1001 }, (_, i) => `d${i},1`).join("\n")}`;
  assert.match(parseMenuCsv(big).errors[0].message, /Too many rows/);
});

test("header aliases", () => {
  const r = parseMenuCsv("Dish,Desc,Price ($),Category\nTea,Hot,4,Drinks\n");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0], { line: 2, name: "Tea", description: "Hot", priceCents: 400, categories: ["Drinks"] });
});

test("export then import round-trips, including commas, quotes and line breaks", () => {
  const items = [
    { name: 'Soup, "house"', description: "Line 1\nLine 2", priceCents: 650, available: false, categories: ["Soups", "Vegetarian"] },
    { name: "Plain", description: null, priceCents: 100, available: true, categories: [] },
  ];
  const r = parseMenuCsv(menuToCsv(items));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows.map(({ line: _l, ...x }) => x), [
    { name: 'Soup, "house"', description: "Line 1\nLine 2", priceCents: 650, available: false, categories: ["Soups", "Vegetarian"] },
    { name: "Plain", description: "", priceCents: 100, available: true, categories: [] },
  ]);
});

test("the downloadable template is itself a valid import", () => {
  const r = parseMenuCsv(TEMPLATE_CSV);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[1].description, "Egg, peas and carrots");
});
