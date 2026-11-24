/**
 * Guard for free-form SQL coming from an AI assistant.
 *
 * This is the first of two layers. The second is that the database is opened
 * read-only, so even a query that slipped past this guard cannot write.
 * The guard exists to give the assistant a clear, early error, to keep it
 * inside the tables you chose to expose, and to stop tricks that a read-only
 * connection does not stop (reading internal tables, attaching other files).
 */

export class QueryRejected extends Error {}

const MAX_LENGTH = 4000;

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint|release|load_extension|trigger|upsert)\b/i;

/**
 * Replaces string literal contents with nothing, and rejects comments and
 * quoted identifiers, which are the usual ways to hide a keyword or a table
 * name from a text-based check.
 */
function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      if (j >= sql.length) throw new QueryRejected("Unterminated string literal");
      out += "''";
      i = j + 1;
      continue;
    }
    if ((ch === "-" && next === "-") || (ch === "/" && next === "*")) {
      throw new QueryRejected("Comments are not allowed in queries");
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      throw new QueryRejected("Quoted identifiers are not allowed; use plain table and column names");
    }
    out += ch;
    i++;
  }
  return out;
}

export interface GuardResult {
  /** The query to run, without a trailing semicolon. */
  sql: string;
  /** Tables the query reads, lower-cased. */
  tables: string[];
  /** The query with string literal contents removed, for further checks. */
  analysis: string;
}

export function guardQuery(input: string, allowedTables: readonly string[]): GuardResult {
  const sql = input.trim();
  if (!sql) throw new QueryRejected("Empty query");
  if (sql.length > MAX_LENGTH) throw new QueryRejected(`Query is longer than ${MAX_LENGTH} characters`);

  let analysis = stripLiterals(sql).trim();
  let body = sql;
  if (analysis.endsWith(";")) {
    analysis = analysis.slice(0, -1).trimEnd();
    body = sql.slice(0, sql.lastIndexOf(";")).trimEnd();
  }
  if (analysis.includes(";")) throw new QueryRejected("Only one statement is allowed");
  if (!/^(select|with)\b/i.test(analysis)) throw new QueryRejected("Only SELECT queries are allowed");

  const forbidden = analysis.match(FORBIDDEN);
  if (forbidden) throw new QueryRejected(`Keyword not allowed: ${forbidden[1].toUpperCase()}`);

  if (/\bfrom\s+[a-z_]\w*(\s+(as\s+)?[a-z_]\w*)?\s*,/i.test(analysis)) {
    throw new QueryRejected("Comma joins are not allowed; use JOIN ... ON");
  }

  const cte = new Set<string>();
  for (const m of analysis.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_]\w*)\s+as\s*\(/gi)) {
    cte.add(m[1].toLowerCase());
  }

  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  const tables = new Set<string>();
  for (const m of analysis.matchAll(/\b(?:from|join)\s+([a-z_]\w*)(\s*\.|\s*\()?/gi)) {
    const name = m[1].toLowerCase();
    if (m[2]?.trim() === ".") throw new QueryRejected("Schema-qualified names are not allowed");
    if (m[2]?.trim() === "(") throw new QueryRejected(`Table functions are not allowed: ${name}`);
    if (cte.has(name)) continue;
    if (!allowed.has(name)) {
      throw new QueryRejected(`Table not available: ${name}. Available tables: ${[...allowed].join(", ")}`);
    }
    tables.add(name);
  }
  return { sql: body, tables: [...tables], analysis };
}

/** Wraps a guarded query so it can never return more than `limit` rows. Fetches one extra row to report truncation. */
export function withLimit(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) LIMIT ${Math.max(1, Math.floor(limit)) + 1}`;
}
