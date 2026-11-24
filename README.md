# crm-readonly-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant answer questions about your CRM **without being able to change it or leak personal data**.

Ask Claude or another MCP client things like *"which deals over $20k went quiet this month?"* or *"what is our win rate by owner?"*. The assistant reads the CRM through six tools. It cannot write, cannot read tables you did not expose, sees emails and phone numbers masked, and every call is logged.

It ships with a demo CRM (40 companies, 120 contacts, 150 deals, about 500 activities) made of fictional data, so you can try it in two minutes.

## Tools

| Tool | What it does |
|---|---|
| `describe_schema` | Exposed tables, their columns and row counts. |
| `search_contacts` | Find contacts by name or company. |
| `get_contact` | One contact with company, deals and the last 10 activities. |
| `pipeline_summary` | Deals and value per stage, open pipeline, win rate. |
| `stale_deals` | Open deals with no activity for N days, biggest first, optionally for one owner. |
| `run_query` | One guarded `SELECT` for questions the other tools do not cover. Row-limited. |

All tools are marked read-only (`readOnlyHint`).

## How it keeps data safe

1. **Read-only connection.** The database is opened in read-only mode. No query can write, whatever else happens.
2. **SQLite authorizer for `run_query`.** While a free query is compiled, SQLite reports every table, column and function it touches, and the server answers for each one. Tables you did not expose (including `sqlite_master`) are refused, every action other than reading is refused, and extension loading is refused. This works on what the query actually does, not on how it is written, so comma joins, unbalanced parentheses or `UNION` tricks do not get around it.
3. **Personal columns read as NULL in free queries.** With masking on, `email` and `phone` come back as `NULL` from `run_query`, so no rename, function (`substr(email, 2)`), `UNION` or `WHERE` probe can reveal them. The fixed tools return them masked instead (`a***@company.example`, `***42`), and email addresses inside free text such as notes are masked too. Contact search does not match on email, so the assistant cannot confirm that an address exists.
4. **Text guard in front.** Before SQLite sees it, a free query must be one `SELECT` or `WITH ... SELECT` with balanced parentheses and no comments, quoted identifiers, comma joins after `FROM`, schema-qualified names or table functions. It gives the assistant a clear error early; the authorizer is what enforces.
5. **Row limits.** Every free query is wrapped as `SELECT * FROM (...) LIMIT n`, and the response says when it was truncated.
6. **Audit log.** One JSON line per call: tool, arguments, row count, time, and the error if it was refused. A failing log write is reported on stderr and never breaks an answer.

## Run it

```bash
npm install
npm run build
npm run seed      # writes the demo CRM to data/demo.db
npm start         # stdio server
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `CRM_DB` | `data/demo.db` | Path to a SQLite CRM database. |
| `AUDIT_FILE` | `data/audit.jsonl` | Where the audit log is appended. |
| `MASK_PII` | `true` | Set to `false` only for trusted, internal use. |
| `MAX_ROWS` | `200` | Hard cap on rows per response (max 1000). |
| `ALLOW_RAW_QUERY` | `true` | Set to `false` to remove free SQL and keep only the fixed tools. |

The demo data is anchored to 2026-11-24, so pass `as_of: "2026-11-24"` to `stale_deals` when you try it.

### Connect to a client

Claude Code:

```bash
claude mcp add crm -e CRM_DB=/path/to/demo.db -- node /path/to/crm-readonly-mcp/dist/index.js
```

Any MCP client with a JSON config:

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["/path/to/crm-readonly-mcp/dist/index.js"],
      "env": { "CRM_DB": "/path/to/demo.db" }
    }
  }
}
```

## Tests

```bash
npm test
```

Twenty-four tests. They cover what the text guard accepts and rejects; that the connection refuses writes even without the guard; that SQLite refuses a hidden table the text guard missed; that `UNION`, CTE column lists and functions return `NULL` for personal columns; that no tool output contains an unmasked email or phone; the audit log, including a log that cannot be written; row caps; and the numbers returned by the pipeline and stale-deal tools. Each protection was also switched off on purpose to confirm that a test fails without it.

## Using it with your own CRM

The tools are written for the demo schema (`companies`, `contacts`, `deals`, `activities`). For a real CRM, the usual route is a nightly read-only copy or replica in SQLite or Postgres with the same table names, or a small adapter per tool. Keep the read-only connection and the audit log whatever you change.

## Limits

- Personal data is protected by column name (`email`, `phone`). If your schema stores personal data under other names, add them to `PII_COLUMN_NAMES` in `src/crm.ts`.
- Free text is masked only for email addresses written as text. A free query that transforms a notes column (for example replacing `@`) can still reveal an address written inside a note. If notes may contain sensitive data, set `ALLOW_RAW_QUERY=false` or expose a pre-masked view.
- SQLite queries run synchronously without a timeout. Row limits bound the output, not the work, so a very heavy join can still be slow on a large database.
- Single user, local stdio server with no authentication. Do not expose it over a network as is.

## License

MIT
