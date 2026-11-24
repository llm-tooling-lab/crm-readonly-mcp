import assert from "node:assert/strict";
import { test } from "node:test";
import { guardQuery, QueryRejected, withLimit } from "../src/guard.js";

const TABLES = ["companies", "contacts", "deals", "activities"];
const ok = (sql: string) => guardQuery(sql, TABLES);
const rejected = (sql: string, why: RegExp) =>
  assert.throws(() => guardQuery(sql, TABLES), (e: unknown) => e instanceof QueryRejected && why.test((e as Error).message), sql);

test("plain SELECT, JOIN, CTE and a trailing semicolon pass", () => {
  assert.deepEqual(ok("SELECT * FROM deals").tables, ["deals"]);
  assert.deepEqual(ok("select d.id from deals d join companies c on c.id = d.company_id;").tables.sort(), ["companies", "deals"]);
  assert.deepEqual(ok("WITH big AS (SELECT * FROM deals WHERE amount_usd > 1000) SELECT COUNT(*) FROM big").tables, ["deals"]);
  assert.equal(ok("SELECT 1;").sql, "SELECT 1");
  assert.deepEqual(ok("SELECT id FROM deals WHERE id IN (SELECT deal_id FROM activities)").tables.sort(), ["activities", "deals"]);
});

test("keywords inside string literals do not trigger the guard", () => {
  assert.deepEqual(ok("SELECT * FROM activities WHERE note = 'please DELETE the old draft; thanks'").tables, ["activities"]);
  assert.deepEqual(ok("SELECT * FROM contacts WHERE last_name = 'O''Brien'").tables, ["contacts"]);
});

test("writes and schema changes are rejected", () => {
  rejected("INSERT INTO deals (id) VALUES (1)", /Only SELECT/);
  rejected("DELETE FROM deals", /Only SELECT/);
  rejected("WITH x AS (SELECT 1) DELETE FROM deals", /DELETE/);
  rejected("WITH x AS (SELECT 1) INSERT INTO deals SELECT * FROM deals", /INSERT/);
  rejected("SELECT 1; DROP TABLE deals", /one statement/);
  rejected("PRAGMA table_info(deals)", /Only SELECT/);
  rejected("SELECT * FROM deals WHERE 1 = 1; ATTACH DATABASE 'x.db' AS x", /one statement/);
});

test("tricks to hide keywords or tables are rejected", () => {
  rejected("SELECT * FROM deals -- comment", /Comments/);
  rejected("SELECT * FROM deals /* x */", /Comments/);
  rejected('SELECT * FROM "sqlite_master"', /Quoted identifiers/);
  rejected("SELECT * FROM `deals`", /Quoted identifiers/);
  rejected("SELECT * FROM [deals]", /Quoted identifiers/);
  rejected("SELECT * FROM 'deals", /Unterminated/);
  rejected("SELECT load_extension('x')", /LOAD_EXTENSION/);
});

test("only exposed tables can be read", () => {
  rejected("SELECT * FROM sqlite_master", /Table not available: sqlite_master/);
  rejected("SELECT * FROM main.deals", /Schema-qualified/);
  rejected("SELECT * FROM pragma_table_info('deals')", /Table functions/);
  rejected("SELECT * FROM deals d, sqlite_master s", /Comma joins/);
  rejected("SELECT * FROM deals JOIN users ON 1 = 1", /Table not available: users/);
});

test("withLimit caps rows and fetches one extra to detect truncation", () => {
  assert.equal(withLimit("SELECT * FROM deals", 10), "SELECT * FROM (SELECT * FROM deals) LIMIT 11");
  assert.equal(withLimit("SELECT 1", 0), "SELECT * FROM (SELECT 1) LIMIT 2");
});
