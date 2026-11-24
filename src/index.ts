#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Crm } from "./crm.js";
import { AuditLog } from "./privacy.js";
import { createServer } from "./server.js";

const dbPath = process.env.CRM_DB ?? "data/demo.db";
if (!existsSync(dbPath)) {
  console.error(`CRM database not found at ${dbPath}. Run "npm run seed" for the demo data or set CRM_DB.`);
  process.exit(1);
}

const crm = new Crm(dbPath, {
  maskPii: process.env.MASK_PII !== "false",
  maxRows: Math.min(Number(process.env.MAX_ROWS ?? 200), 1000),
  allowRawQuery: process.env.ALLOW_RAW_QUERY !== "false",
});
const audit = new AuditLog(process.env.AUDIT_FILE ?? "data/audit.jsonl");
await createServer(crm, audit).connect(new StdioServerTransport());
// stdout carries the protocol, so diagnostics go to stderr.
console.error(`crm-readonly MCP server running on stdio (db: ${dbPath}, PII masking: ${process.env.MASK_PII !== "false"})`);
