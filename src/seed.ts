import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Builds a demo CRM database with fictional data. Every name, company and
 * address is generated; emails use the reserved .example domain and phone
 * numbers use the 555-01xx fiction range.
 */

export const DEMO_NOW = "2026-11-24";

const SCHEMA = `
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  country TEXT NOT NULL,
  employees INTEGER NOT NULL
);
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  title TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE deals (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  name TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  amount_usd INTEGER NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  expected_close TEXT NOT NULL
);
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL CHECK (type IN ('call','email','meeting','note')),
  note TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX deals_stage ON deals(stage);
CREATE INDEX activities_deal ON activities(deal_id);
`;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ava", "Liam", "Maya", "Noah", "Iris", "Owen", "Lena", "Theo", "Nora", "Eli", "Ruby", "Finn", "Zoe", "Hugo", "Mila", "Leo"];
const LAST = ["Hart", "Quinn", "Reyes", "Novak", "Silva", "Brooks", "Lind", "Okafor", "Moreau", "Tanaka", "Weber", "Costa", "Ivers", "Dale"];
const PREFIX = ["North", "Blue", "Bright", "Clear", "Cedar", "Summit", "River", "Stone", "Harbor", "Pixel", "Atlas", "Maple"];
const SUFFIX = ["Logistics", "Dental", "Studios", "Foods", "Analytics", "Realty", "Health", "Outdoor", "Labs", "Freight", "Retail", "Energy"];
const INDUSTRY: Record<string, string> = {
  Logistics: "logistics", Freight: "logistics", Dental: "healthcare", Health: "healthcare", Studios: "media",
  Foods: "food", Analytics: "software", Labs: "software", Realty: "real estate", Outdoor: "retail", Retail: "retail", Energy: "energy",
};
const COUNTRY = ["US", "US", "US", "CA", "GB", "DE", "BR", "AU", "ES", "MX"];
const TITLE = ["Head of Operations", "CEO", "Procurement Manager", "CTO", "Marketing Director", "Office Manager", "VP Sales"];
const OWNER = ["Sam Rivera", "Jordan Lee", "Alex Morgan"];
const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
const STAGE_WEIGHT = [0.22, 0.2, 0.18, 0.12, 0.16, 0.12];
const DEAL_KIND = ["Annual plan", "Pilot", "Expansion", "Onboarding package", "Support renewal", "Integration project"];
const NOTES: Record<string, string[]> = {
  call: ["Discussed pricing tiers", "Asked for a security review", "Budget approved for Q1", "Wants a shorter contract", "No answer, left voicemail"],
  email: ["Sent proposal PDF", "Followed up on the trial", "Shared case study", "Answered integration questions", "Reminder about renewal date"],
  meeting: ["Demo with the ops team", "Kickoff call scheduled", "Procurement meeting", "Technical deep dive"],
  note: ["Decision maker changed", "Competitor is cheaper", "Champion is on leave until next month", "Asked to send invoices to billing contact"],
};

const day = (base: string, offset: number) => {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

export function buildDemoDb(path: string, seed = 42): void {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
  }
  const r = rng(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec("BEGIN");

  const insCompany = db.prepare("INSERT INTO companies VALUES (?,?,?,?,?)");
  const insContact = db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?)");
  const insDeal = db.prepare("INSERT INTO deals VALUES (?,?,?,?,?,?,?,?,?,?)");
  const insAct = db.prepare("INSERT INTO activities VALUES (?,?,?,?,?,?)");

  const companies: { id: number; slug: string }[] = [];
  const used = new Set<string>();
  for (let id = 1; companies.length < 40; id++) {
    const suffix = pick(SUFFIX);
    const name = `${pick(PREFIX)} ${suffix}`;
    if (used.has(name)) continue;
    used.add(name);
    const cid = companies.length + 1;
    insCompany.run(cid, name, INDUSTRY[suffix], pick(COUNTRY), 5 + Math.floor(r() * 800));
    companies.push({ id: cid, slug: name.toLowerCase().replace(/\s+/g, "") });
  }

  const contacts: { id: number; company: number }[] = [];
  for (let id = 1; id <= 120; id++) {
    const c = companies[Math.floor(r() * companies.length)];
    const f = pick(FIRST);
    const l = pick(LAST);
    const phone = `+1-202-555-01${String(Math.floor(r() * 100)).padStart(2, "0")}`;
    insContact.run(id, c.id, f, l, pick(TITLE), `${f}.${l}@${c.slug}.example`.toLowerCase(), phone, day(DEMO_NOW, -400 + Math.floor(r() * 380)));
    contacts.push({ id, company: c.id });
  }

  let actId = 1;
  for (let id = 1; id <= 150; id++) {
    const ct = contacts[Math.floor(r() * contacts.length)];
    let x = r();
    let s = 0;
    while (s < STAGES.length - 1 && x > STAGE_WEIGHT[s]) x -= STAGE_WEIGHT[s++];
    const stage = STAGES[s];
    const created = -200 + Math.floor(r() * 190);
    const last = Math.min(0, created + Math.floor(r() * 120));
    insDeal.run(
      id, ct.company, ct.id, `${pick(DEAL_KIND)} ${2026 + Math.floor(r() * 2)}`, stage,
      500 * (2 + Math.floor(r() * 120)), pick(OWNER), day(DEMO_NOW, created), day(DEMO_NOW, last), day(DEMO_NOW, last + 15 + Math.floor(r() * 75)),
    );
    const n = 1 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) {
      const type = pick(["call", "email", "meeting", "note"] as const);
      let note = pick(NOTES[type]);
      // Some free-text notes carry contact details, which is realistic and tests masking.
      if (r() < 0.1) note += ` (cc billing@${companies[ct.company - 1].slug}.example)`;
      const at = k === n - 1 ? last : created + Math.floor(((last - created) * k) / n);
      insAct.run(actId++, id, ct.id, type, note, day(DEMO_NOW, at));
    }
  }
  db.exec("COMMIT");
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  const out = process.argv[2] ?? "data/demo.db";
  buildDemoDb(out);
  console.error(`demo CRM written to ${out}`);
}
