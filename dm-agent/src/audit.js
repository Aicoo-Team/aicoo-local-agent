import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only record of every gate decision.
 *
 * While approval is per-call the terminal is the record. The moment a standing grant
 * exists, this file is the only way anyone answers "what has that person's agent actually
 * read from my machine?" — so it is written from the start, and it records the rule that
 * decided, not just the outcome.
 */
export class AuditLog {
  constructor(file, { log } = {}) {
    this.file = file;
    this.log = log;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* the audit never fails a turn */
    }
  }

  record(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try {
      appendFileSync(this.file, `${line}\n`);
    } catch (error) {
      this.log?.(`[audit] could not write: ${String(error.message ?? error)}`);
    }
  }
}
