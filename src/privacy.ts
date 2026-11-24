import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Keeps the last two digits so a person can still tell numbers apart. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 4 ? "***" : `***${digits.slice(-2)}`;
}

/**
 * Masks personal data in one result row: columns that hold emails or phone
 * numbers, and any email address inside free text such as notes.
 */
export function maskRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") {
      out[key] = value;
    } else if (/email/i.test(key)) {
      out[key] = maskEmail(value);
    } else if (/phone|mobile|tel/i.test(key)) {
      out[key] = maskPhone(value);
    } else {
      out[key] = value.replace(EMAIL_IN_TEXT, (m) => maskEmail(m));
    }
  }
  return out;
}

export interface AuditEntry {
  at: string;
  tool: string;
  args: unknown;
  rows?: number;
  ms: number;
  error?: string;
}

/** Append-only record of every tool call, so a human can see what the assistant looked at. */
export class AuditLog {
  constructor(private readonly file?: string) {}

  write(entry: AuditEntry): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }
}
