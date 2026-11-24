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

1. **Read-only connection.** The database is opened in read-only mode. Even a query that got past every other check cannot write.
2. **Query guard for `run_query`.** One statement only, `SELECT` or `WITH ... SELECT`. No comments, quoted identifiers, comma joins, schema-qualified names or table functions, which are the usual ways to hide a keyword or reach `sqlite_master`. Only the exposed tables can be read. Keywords inside string literals are ignored, so a note that says "please delete" does not trip it.
3. **Row limits.** Every free query is wrapped as `SELECT * FROM (...) LIMIT n`, and the response says when it was truncated.
4. **PII masking, on by default.** Email and phone columns are masked (`a***@company.example`, `***42`), and so are email addresses inside free text such as notes. While masking is on, `run_query` refuses to touch email or phone columns directly, because a function like `substr(email, 2)` would rename the column and slip past masking. Search does not match on email either, so the assistant cannot confirm that an address exists.
5. **Audit log.** One JSON line per call: tool, arguments, row count, time, and the error if it was refused.

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

Seventeen tests. They cover what the guard accepts and rejects (writes, stacked statements, comments, quoted identifiers, internal tables, table functions, comma joins), that the connection refuses writes even without the guard, that no tool output contains an unmasked email or phone, that renaming a personal column cannot bypass masking, the audit log, row caps, and the numbers returned by the pipeline and stale-deal tools.

## Using it with your own CRM

The tools are written for the demo schema (`companies`, `contacts`, `deals`, `activities`). For a real CRM, the usual route is a nightly read-only copy or replica in SQLite or Postgres with the same table names, or a small adapter per tool. Keep the read-only connection and the audit log whatever you change.

## Limits

- The guard checks SQL text. It is a strong filter, not a parser, and the read-only connection is the layer that actually guarantees nothing is written. For the strictest setup, set `ALLOW_RAW_QUERY=false`.
- Masking of free text catches email addresses written as text. A query that transforms a notes column (for example replacing `@`) can still reveal an address written inside a note. If notes may contain sensitive data, turn off `run_query` or expose a pre-masked view.
- SQLite queries run synchronously without a timeout. Row limits bound the output, not the work, so a very heavy join can still be slow on a large database.
- Single user, local stdio server with no authentication. Do not expose it over a network as is.

## License

MIT
