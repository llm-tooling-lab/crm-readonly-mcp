import { constants, DatabaseSync } from "node:sqlite";
import { guardQuery, QueryRejected, withLimit } from "./guard.js";
import { maskRow } from "./privacy.js";

export const EXPOSED_TABLES = ["companies", "contacts", "deals", "activities"] as const;
const STAGE_ORDER = "CASE stage WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3 WHEN 'negotiation' THEN 4 WHEN 'won' THEN 5 ELSE 6 END";

type Row = Record<string, unknown>;

export interface CrmOptions {
  maskPii: boolean;
  maxRows: number;
  /** Allow free-form SELECT through run_query. Turn off for the strictest setup. */
  allowRawQuery?: boolean;
}

/** Columns holding personal data. While masking is on, run_query may not touch them directly. */
const PII_COLUMNS = /\b(email|phone)\b/i;
const PII_COLUMN_NAMES = new Set(["email", "phone"]);
/** SQL functions run_query may never call, whatever the text guard thinks. */
const BLOCKED_FUNCTIONS = new Set(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer"]);

/** Read-only access to the CRM database. Every method returns masked rows unless masking is turned off. */
export class Crm {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly opts: CrmOptions,
  ) {
    // Second layer of defence: the connection itself cannot write.
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  private rows(sql: string, ...params: (string | number)[]): Row[] {
    const result = this.db.prepare(sql).all(...params) as Row[];
    return this.opts.maskPii ? result.map(maskRow) : result;
  }

  schema() {
    return EXPOSED_TABLES.map((table) => {
      const columns = (this.db.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all() as Row[]).map(
        (c) => `${c.name} ${c.type}`,
      );
      const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return { table, rows: n, columns };
    });
  }

  searchContacts(query: string, limit: number) {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    // With masking on, searching by email would let a caller confirm that an address exists, so only names and companies are searched.
    const byEmail = this.opts.maskPii ? "" : "OR c.email LIKE ?3";
    return this.rows(
      `SELECT c.id, c.first_name, c.last_name, c.title, c.email, c.phone, co.name AS company
       FROM contacts c JOIN companies co ON co.id = c.company_id
       WHERE c.first_name || ' ' || c.last_name LIKE ?1 OR co.name LIKE ?2 ${byEmail}
       ORDER BY c.last_name, c.first_name LIMIT ?4`,
      like, like, like, Math.min(limit, this.opts.maxRows),
    );
  }

  contact(id: number) {
    const [person] = this.rows(
      `SELECT c.*, co.name AS company, co.industry, co.country
       FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = ?`,
      id,
    );
    if (!person) return null;
    return {
      contact: person,
      deals: this.rows(
        `SELECT id, name, stage, amount_usd, owner, last_activity_at, expected_close FROM deals
         WHERE contact_id = ? ORDER BY ${STAGE_ORDER}, last_activity_at DESC`,
        id,
      ),
      recent_activity: this.rows(
        `SELECT a.at, a.type, a.note, d.name AS deal FROM activities a JOIN deals d ON d.id = a.deal_id
         WHERE a.contact_id = ? ORDER BY a.at DESC, a.id DESC LIMIT 10`,
        id,
      ),
    };
  }

  pipeline() {
    const stages = this.rows(
      `SELECT stage, COUNT(*) AS deals, SUM(amount_usd) AS amount_usd, ROUND(AVG(amount_usd)) AS avg_deal_usd
       FROM deals GROUP BY stage ORDER BY ${STAGE_ORDER}`,
    );
    const [totals] = this.rows(
      `SELECT
         SUM(CASE WHEN stage NOT IN ('won','lost') THEN amount_usd ELSE 0 END) AS open_amount_usd,
         SUM(CASE WHEN stage = 'won' THEN 1 ELSE 0 END) AS won,
         SUM(CASE WHEN stage = 'lost' THEN 1 ELSE 0 END) AS lost
       FROM deals`,
    );
    const won = Number(totals.won);
    const lost = Number(totals.lost);
    return { stages, open_amount_usd: totals.open_amount_usd, win_rate: won + lost ? Math.round((100 * won) / (won + lost)) / 100 : null };
  }

  staleDeals(days: number, asOf: string, owner?: string) {
    const params: (string | number)[] = [asOf, days];
    let ownerFilter = "";
    if (owner) {
      ownerFilter = "AND d.owner = ?";
      params.push(owner);
    }
    return this.rows(
      `SELECT d.id, d.name, d.stage, d.amount_usd, d.owner, d.last_activity_at,
              CAST(julianday(?1) - julianday(d.last_activity_at) AS INTEGER) AS days_silent,
              co.name AS company, c.first_name || ' ' || c.last_name AS contact, c.email
       FROM deals d JOIN companies co ON co.id = d.company_id JOIN contacts c ON c.id = d.contact_id
       WHERE d.stage NOT IN ('won','lost')
         AND julianday(?1) - julianday(d.last_activity_at) >= ?2 ${ownerFilter.replace("?", "?3")}
       ORDER BY d.amount_usd DESC LIMIT ${this.opts.maxRows}`,
      ...params,
    );
  }

  /** Free-form SELECT, guarded and limited. */
  query(sql: string, limit: number) {
    if (this.opts.allowRawQuery === false) throw new QueryRejected("run_query is turned off on this server");
    const guarded = guardQuery(sql, EXPOSED_TABLES);
    if (this.opts.maskPii && PII_COLUMNS.test(guarded.analysis)) {
      // Masking works on result columns; a function such as substr(email, 2) would rename the column and slip past it.
      throw new QueryRejected(
        "Personal columns (email, phone) cannot be used in run_query while masking is on. Use SELECT * or search_contacts / get_contact, which return them masked.",
      );
    }
    const max = Math.min(limit, this.opts.maxRows);
    const allowed = new Set<string>(EXPOSED_TABLES);
    const denied: string[] = [];
    // Third layer: SQLite itself reports every table and column the statement touches while it is compiled.
    // This holds however the SQL is written, so it closes what a text check cannot (comma joins after ON,
    // unbalanced parentheses, UNION renaming columns, CTE column lists).
    this.db.setAuthorizer((action, arg1, arg2) => {
      if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK;
      if (action === constants.SQLITE_READ) {
        const table = String(arg1 ?? "").toLowerCase();
        if (!allowed.has(table)) {
          denied.push(`table ${table}`);
          return constants.SQLITE_DENY;
        }
        // Personal columns read as NULL in free queries: no rename, function or WHERE clause can reveal them.
        if (this.opts.maskPii && PII_COLUMN_NAMES.has(String(arg2 ?? "").toLowerCase())) return constants.SQLITE_IGNORE;
        return constants.SQLITE_OK;
      }
      if (action === constants.SQLITE_FUNCTION) {
        const fn = String(arg2 ?? "").toLowerCase();
        if (BLOCKED_FUNCTIONS.has(fn)) {
          denied.push(`function ${fn}`);
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      }
      denied.push(`action ${action}`);
      return constants.SQLITE_DENY;
    });
    let all: Row[];
    try {
      all = this.rows(withLimit(guarded.sql, max));
    } catch (err) {
      if (denied.length) throw new QueryRejected(`Not allowed: ${[...new Set(denied)].join(", ")}`);
      throw err;
    } finally {
      this.db.setAuthorizer(null);
    }
    return { tables: guarded.tables, rows: all.slice(0, max), truncated: all.length > max };
  }
}
