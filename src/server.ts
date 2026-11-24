import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Crm } from "./crm.js";
import { QueryRejected } from "./guard.js";
import type { AuditLog } from "./privacy.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function createServer(crm: Crm, audit: AuditLog, now: () => string = () => new Date().toISOString().slice(0, 10)): McpServer {
  const server = new McpServer({ name: "crm-readonly", version: "0.1.0" });

  /** Runs a tool body, writes one audit line, and turns errors into tool errors the assistant can read. */
  const run = (tool: string, args: unknown, body: () => unknown): ToolResult => {
    const started = Date.now();
    try {
      const value = body();
      const rows = Array.isArray(value) ? value.length : (value as { rows?: unknown[] } | null)?.rows?.length;
      audit.write({ at: new Date().toISOString(), tool, args, rows, ms: Date.now() - started });
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    } catch (err) {
      const message = err instanceof QueryRejected ? `Query rejected: ${err.message}` : `Error: ${(err as Error).message}`;
      audit.write({ at: new Date().toISOString(), tool, args, ms: Date.now() - started, error: message });
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };

  server.registerTool(
    "describe_schema",
    {
      title: "Describe CRM schema",
      description: "Tables you can read, their columns and row counts. Call this before writing a query.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("describe_schema", {}, () => crm.schema()),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description: "Find contacts by name, email or company name. Personal data is masked.",
      inputSchema: {
        query: z.string().min(2).max(100),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run("search_contacts", args, () => crm.searchContacts(args.query, args.limit)),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Contact with deals and recent activity",
      description: "One contact with their company, deals and last 10 activities.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      run("get_contact", { id }, () => {
        const c = crm.contact(id);
        if (!c) throw new Error(`No contact with id ${id}`);
        return c;
      }),
  );

  server.registerTool(
    "pipeline_summary",
    {
      title: "Pipeline summary",
      description: "Deals per stage with totals, open pipeline value and win rate.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("pipeline_summary", {}, () => crm.pipeline()),
  );

  server.registerTool(
    "stale_deals",
    {
      title: "Deals that went quiet",
      description: "Open deals with no activity for at least N days, biggest first. Use it to plan follow-ups.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(21),
        as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date to measure from, YYYY-MM-DD. Defaults to today."),
        owner: z.string().optional().describe("Only deals of this sales owner"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run("stale_deals", args, () => crm.staleDeals(args.days, args.as_of ?? now(), args.owner)),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a read-only SQL query",
      description:
        "One SELECT (or WITH ... SELECT) over the CRM tables, for questions the other tools do not cover. " +
        "No comments, quoted identifiers, comma joins or table functions. Results are row-limited and personal data is masked.",
      inputSchema: {
        sql: z.string().min(1).max(4000),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => run("run_query", args, () => crm.query(args.sql, args.limit)),
  );

  return server;
}
