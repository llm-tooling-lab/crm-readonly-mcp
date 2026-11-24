import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Crm } from "../src/crm.js";
import { AuditLog, maskEmail, maskPhone, maskRow } from "../src/privacy.js";
import { buildDemoDb, DEMO_NOW } from "../src/seed.js";
import { createServer } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "crm-"));
const dbPath = join(dir, "demo.db");
before(() => buildDemoDb(dbPath));

async function connect(opts: { maskPii?: boolean; allowRawQuery?: boolean } = {}) {
  const auditFile = join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl");
  const crm = new Crm(dbPath, { maskPii: opts.maskPii ?? true, maxRows: 200, allowRawQuery: opts.allowRawQuery });
  const server = createServer(crm, new AuditLog(auditFile), () => DEMO_NOW);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
  return { call, client, auditFile };
}

const EMAIL = /[a-z0-9._%+-]{2,}@[a-z0-9.-]+\.[a-z]{2,}/i; // two or more chars before @ means unmasked

test("masking helpers", () => {
  assert.equal(maskEmail("ava.hart@northlabs.example"), "a***@northlabs.example");
  assert.equal(maskPhone("+1-202-555-0142"), "***42");
  assert.deepEqual(maskRow({ email: "x.y@a.example", work_phone: "555 0199", note: "cc billing@co.example please", n: 3 }), {
    email: "x***@a.example", work_phone: "***99", note: "cc b***@co.example please", n: 3,
  });
});

test("the database connection is read-only even without the guard", () => {
  const crm = new Crm(dbPath, { maskPii: true, maxRows: 10 });
  const raw = (crm as unknown as { db: DatabaseSync }).db;
  assert.throws(() => raw.exec("DELETE FROM deals"), /readonly/i);
  crm.close();
});

test("server lists six read-only tools", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["describe_schema", "get_contact", "pipeline_summary", "run_query", "search_contacts", "stale_deals"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
});

test("describe_schema shows only the exposed tables", async () => {
  const { call } = await connect();
  const schema = (await call("describe_schema")).json();
  assert.deepEqual(schema.map((t: { table: string }) => t.table), ["companies", "contacts", "deals", "activities"]);
  assert.equal(schema.find((t: { table: string }) => t.table === "deals").rows, 150);
});

test("no tool output contains an unmasked email or phone when masking is on", async () => {
  const { call } = await connect();
  const outputs = [
    (await call("search_contacts", { query: "ha" })).text,
    (await call("get_contact", { id: 1 })).text,
    (await call("stale_deals", { days: 1 })).text,
    (await call("run_query", { sql: "SELECT * FROM contacts", limit: 500 })).text,
    (await call("run_query", { sql: "SELECT * FROM activities", limit: 500 })).text,
  ];
  for (const out of outputs) {
    assert.doesNotMatch(out, EMAIL);
    assert.doesNotMatch(out, /555-01\d\d/);
  }
});

test("run_query cannot rename personal columns to slip past masking", async () => {
  const { call } = await connect();
  for (const sql of [
    "SELECT substr(email, 2, 20) AS x FROM contacts",
    "SELECT replace(email, '@', ' at ') AS x FROM contacts",
    "SELECT id FROM contacts WHERE email LIKE 'a%'",
    "SELECT phone || '' AS p FROM contacts",
  ]) {
    const r = await call("run_query", { sql });
    assert.equal(r.error, true, sql);
    assert.match(r.text, /Personal columns/);
  }
});

test("search does not match on email while masking is on, but does when it is off", async () => {
  const masked = await connect();
  const unmasked = await connect({ maskPii: false });
  const domain = "riverstudios.example";
  assert.equal(masked.call && (await masked.call("search_contacts", { query: domain })).json().length, 0);
  assert.ok((await unmasked.call("search_contacts", { query: domain })).json().length > 0);
});

test("run_query errors are explained and logged, results are capped", async () => {
  const { call, auditFile } = await connect();
  const bad = await call("run_query", { sql: "DELETE FROM deals" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /Query rejected: Only SELECT/);
  const capped = (await call("run_query", { sql: "SELECT id FROM deals", limit: 5 })).json();
  assert.equal(capped.rows.length, 5);
  assert.equal(capped.truncated, true);
  const log = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 2);
  assert.equal(log[0].tool, "run_query");
  assert.match(log[0].error, /Only SELECT/);
  assert.equal(log[1].rows, 5);
});

test("run_query can be turned off entirely", async () => {
  const { call } = await connect({ allowRawQuery: false });
  const r = await call("run_query", { sql: "SELECT 1" });
  assert.equal(r.error, true);
  assert.match(r.text, /turned off/);
});

test("pipeline and stale deals add up", async () => {
  const { call } = await connect();
  const p = (await call("pipeline_summary")).json();
  const total = p.stages.reduce((s: number, x: { deals: number }) => s + x.deals, 0);
  assert.equal(total, 150);
  const stale = (await call("stale_deals", { days: 30 })).json();
  assert.ok(stale.length > 0);
  for (const d of stale) {
    assert.ok(d.days_silent >= 30);
    assert.ok(!["won", "lost"].includes(d.stage));
  }
  const amounts = stale.map((d: { amount_usd: number }) => d.amount_usd);
  assert.deepEqual(amounts, [...amounts].sort((a: number, b: number) => b - a));
  const owner = (await call("stale_deals", { days: 30, owner: "Sam Rivera" })).json();
  assert.ok(owner.every((d: { owner: string }) => d.owner === "Sam Rivera"));
});

test("get_contact returns a clear error for an unknown id", async () => {
  const { call } = await connect();
  const r = await call("get_contact", { id: 99999 });
  assert.equal(r.error, true);
  assert.match(r.text, /No contact with id 99999/);
});

test("SQLite itself refuses tables the text guard missed (comma join after ON)", async () => {
  const { call } = await connect();
  const r = await call("run_query", {
    sql: "SELECT sqlite_master.sql FROM deals JOIN contacts ON contacts.id = deals.contact_id, sqlite_master",
  });
  assert.equal(r.error, true);
  assert.match(r.text, /Not allowed: table sqlite_master/);
  // the authorizer is cleared afterwards, so the fixed tools keep working
  assert.equal((await call("describe_schema")).error, false);
});

test("renaming tricks return NULL for personal columns instead of the data", async () => {
  const { call } = await connect();
  const union = (await call("run_query", { sql: "SELECT 1,2,3,4,5,6,7,8 UNION ALL SELECT * FROM contacts", limit: 10 })).json();
  for (const row of union.rows.slice(1)) {
    assert.equal(row["6"], null);
    assert.equal(row["7"], null);
    assert.ok(row["3"]); // first name is not personal contact data and still comes through
  }
  const cte = (await call("run_query", { sql: "WITH x(a,b,c,d,e,f,g,h) AS (SELECT * FROM contacts) SELECT substr(f, 2) AS s, g FROM x" })).json();
  assert.ok(cte.rows.every((r: { s: unknown; g: unknown }) => r.s === null && r.g === null));
  const star = (await call("run_query", { sql: "SELECT * FROM contacts" })).json();
  assert.ok(star.rows.every((r: { email: unknown; phone: unknown }) => r.email === null && r.phone === null));
});

test("a WHERE clause cannot probe an email that the query never names", async () => {
  const { call } = await connect();
  const r = (await call("run_query", {
    sql: "WITH x(a,b,c,d,e,f) AS (SELECT id, company_id, first_name, last_name, title, email FROM contacts) SELECT a FROM x WHERE f LIKE '%example%'",
  }));
  // either refused by the text rule or answered with nothing; never a match on real addresses
  if (!r.error) assert.equal(r.json().rows.length, 0);
});

test("with masking off, run_query returns real contact columns", async () => {
  const { call } = await connect({ maskPii: false });
  const row = (await call("run_query", { sql: "SELECT email FROM contacts WHERE id = 1" })).json().rows[0];
  assert.match(row.email, /@.+\.example$/);
});

test("a failing audit log does not break an answer", async () => {
  const crm = new Crm(dbPath, { maskPii: true, maxRows: 10 });
  const server = createServer(crm, new AuditLog("/dev/null/cannot/write.jsonl"), () => DEMO_NOW);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = (await client.callTool({ name: "pipeline_summary", arguments: {} })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
});
